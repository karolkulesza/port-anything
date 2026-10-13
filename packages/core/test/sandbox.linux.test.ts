import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SandboxUnavailableError,
  chooseSandbox,
  localHost,
  probeSandbox,
  sandboxCommand,
  type SandboxSetup,
} from '../src/sandbox.js';
import { hostWithoutUserNamespaces } from './helpers/no-userns.js';

// These need bubblewrap and unprivileged user namespaces: they run in the Linux dev container
// (scripts/dev-linux.sh sets PA_SANDBOX_TESTS=1), not on macOS or a stock CI runner.
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('local sandbox (Linux)', () => {
  let root: string;
  let workdir: string;
  let server: Server;
  let port: number;
  let unixServers: Server[];
  let unixPaths: string[];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pa-sandbox-'));
    workdir = join(root, 'case');
    mkdirSync(workdir);
    mkdirSync(join(root, 'outside'));
    server = createServer((socket) => socket.end('hello\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    // Service sockets outside the workdir, like D-Bus in /run/user/<uid> on a real host (the dev
    // container creates that dir) or an agent socket under /tmp.
    unixPaths = [join(`/run/user/${process.getuid!()}`, `pa-${process.pid}.sock`), join(root, 'service.sock')];
    unixServers = await Promise.all(
      unixPaths.map(async (path) => {
        const unixServer = createServer((socket) => socket.end('hello\n'));
        await new Promise<void>((resolve) => unixServer.listen(path, resolve));
        return unixServer;
      }),
    );
  });

  afterAll(() => {
    server.close();
    for (const unixServer of unixServers) unixServer.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Async, so the test server in this process can answer while the case runs.
  function runCase(setup: SandboxSetup, argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const { command, args, cwd } = sandboxCommand(setup, argv, workdir);
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  }

  // Connects to a test server: exit 0 if it answers, 1 on any error.
  const connect = (target: string) => [
    process.execPath,
    '-e',
    `require('net').connect(${target}).on('data', () => process.exit(0)).on('error', (e) => { console.error(e.code); process.exit(1); })`,
  ];
  const tcp = () => connect(`${port}, '127.0.0.1'`);
  const unix = (path: string) => connect(JSON.stringify(path));

  const NONE: SandboxSetup = { kind: 'none' };
  const BWRAP: SandboxSetup[] = [
    { kind: 'bwrap', isolatePids: true },
    { kind: 'bwrap', isolatePids: false },
  ];
  const UNSHARE: SandboxSetup[] = [
    { kind: 'unshare', mapCurrentUser: true },
    { kind: 'unshare', mapCurrentUser: false },
  ];
  const name = (setup: SandboxSetup) => JSON.stringify(setup);

  it('the probe finds bwrap with a PID namespace', async () => {
    // The dev container allows mounting /proc (systempaths=unconfined), like a real host.
    const probe = await probeSandbox();
    expect(probe.attempts[0]).toEqual({ kind: 'bwrap', ok: true });
    expect(chooseSandbox(probe)).toEqual({ kind: 'bwrap', isolatePids: true, label: 'bwrap, no network' });
  });

  it('a case that opens a TCP socket fails in every sandbox (and works without one)', async () => {
    expect((await runCase(NONE, tcp())).status).toBe(0);
    for (const setup of [...BWRAP, ...UNSHARE]) {
      const result = await runCase(setup, tcp());
      expect(result.status, `${name(setup)}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toMatch(/ECONNREFUSED|ENETUNREACH/);
    }
  });

  it('a case that connects to a Unix socket outside its workdir fails under bwrap', async () => {
    for (const path of unixPaths) {
      expect((await runCase(NONE, unix(path))).status, path).toBe(0);
      for (const setup of BWRAP) {
        const result = await runCase(setup, unix(path));
        expect(result.status, `${path} ${name(setup)}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toMatch(/ENOENT/);
      }
    }
  });

  it("a case can't signal the user's other processes under bwrap with a PID namespace", async () => {
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const result = await runCase(BWRAP[0]!, ['sh', '-c', `kill -9 ${victim.pid} && echo killed`]);
      expect(result.stdout).not.toContain('killed');
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
      expect(process.kill(victim.pid!, 0)).toBe(true);
    } finally {
      victim.kill('SIGKILL');
    }
  });

  it.each(BWRAP)('a case that writes outside its workdir fails under bwrap, and writes inside it work (%j)', async (setup) => {
    const script = [
      'echo in > result.txt',
      'echo out > ../outside/escaped.txt || echo blocked-sibling >&2',
      `echo out > ${join(homedir(), 'pa-escaped.txt')} || echo blocked-home >&2`,
      'echo out > /var/tmp/pa-escaped.txt || echo blocked-var-tmp >&2',
      'echo private > /tmp/pa-private.txt && echo tmp-ok >&2',
    ].join('\n');
    const result = await runCase(setup, ['sh', '-c', script]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('blocked-sibling');
    expect(result.stderr).toContain('blocked-home');
    expect(result.stderr).toContain('blocked-var-tmp');
    expect(result.stderr).toContain('tmp-ok');
    expect(readFileSync(join(workdir, 'result.txt'), 'utf8')).toBe('in\n');
    expect(existsSync(join(root, 'outside', 'escaped.txt'))).toBe(false);
    expect(existsSync(join(homedir(), 'pa-escaped.txt'))).toBe(false);
    expect(existsSync('/var/tmp/pa-escaped.txt')).toBe(false);
    // The sandbox's /tmp is private: nothing lands in the host's.
    expect(existsSync('/tmp/pa-private.txt')).toBe(false);
  });

  it('a case reads its fixtures, writes its outputs, and runs as the calling user', async () => {
    writeFileSync(join(workdir, 'in.txt'), 'b\na\n');
    const uid = String(process.getuid!());
    for (const setup of [...BWRAP, ...UNSHARE, NONE]) {
      rmSync(join(workdir, 'out.txt'), { force: true });
      const result = await runCase(setup, ['sh', '-c', 'sort in.txt | tee out.txt; id -u']);
      // Unmapped unshare (util-linux before 2.38) shows the overflow uid; file access is unchanged.
      const shownUid = setup.kind === 'unshare' && !setup.mapCurrentUser ? '65534' : uid;
      expect(result.stdout, name(setup)).toBe(`a\nb\n${shownUid}\n`);
      expect(readFileSync(join(workdir, 'out.txt'), 'utf8'), name(setup)).toBe('a\nb\n');
    }
  });

  it('with user namespaces disabled, it refuses and prints the fix; --no-sandbox still runs', async () => {
    const probe = await probeSandbox(hostWithoutUserNamespaces(localHost()));
    expect(probe.usable).toBeUndefined();
    expect(probe.attempts.map((a) => a.kind)).toEqual(['bwrap', 'unshare']);
    expect(probe.attempts[0]!.error).toMatch(/No permissions to create new namespace/);
    expect(probe.attempts[1]!.error).toMatch(/Operation not permitted/);

    let error: unknown;
    try {
      chooseSandbox(probe);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SandboxUnavailableError);
    const message = (error as Error).message;
    console.log(message); // what a user sees
    expect(message).toContain('No local sandbox works here');
    expect(message).toContain('--security-opt seccomp=unconfined'); // the dev container is Docker
    expect(message).toContain('--no-sandbox');

    expect(chooseSandbox(probe, { noSandbox: true }).kind).toBe('none');
  });
});

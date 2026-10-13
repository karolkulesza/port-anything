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
  type SandboxKind,
} from '../src/sandbox.js';
import { hostWithoutUserNamespaces } from './helpers/no-userns.js';

// These need bubblewrap and unprivileged user namespaces: they run in the Linux dev container
// (scripts/dev-linux.sh sets PA_SANDBOX_TESTS=1), not on macOS or a stock CI runner.
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('local sandbox (Linux)', () => {
  let root: string;
  let workdir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pa-sandbox-'));
    workdir = join(root, 'case');
    mkdirSync(workdir);
    mkdirSync(join(root, 'outside'));
    server = createServer((socket) => socket.end('hello\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Async, so the test server in this process can answer while the case runs.
  function runCase(kind: SandboxKind, argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const { command, args, cwd } = sandboxCommand(kind, argv, workdir);
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  }

  // Connects to the test server on the host's loopback: exit 0 if it answers, 1 on any error.
  const connect = () => [
    process.execPath,
    '-e',
    `require('net').connect(${port}, '127.0.0.1').on('data', () => process.exit(0)).on('error', (e) => { console.error(e.code); process.exit(1); })`,
  ];

  it('the probe finds bwrap', async () => {
    const probe = await probeSandbox();
    expect(probe.attempts[0]).toEqual({ kind: 'bwrap', ok: true });
    expect(chooseSandbox(probe)).toEqual({ kind: 'bwrap', label: 'bwrap, no network' });
  });

  it('a case that opens a socket fails in both sandboxes (and works without one)', async () => {
    expect((await runCase('none', connect())).status).toBe(0);
    for (const kind of ['bwrap', 'unshare'] as const) {
      const result = await runCase(kind, connect());
      expect(result.status, `${kind}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toMatch(/ECONNREFUSED|ENETUNREACH/);
    }
  });

  it('a case that writes outside its workdir fails under bwrap, and writes inside it work', async () => {
    const script = [
      'echo in > result.txt',
      'echo out > ../outside/escaped.txt || echo blocked-sibling >&2',
      `echo out > ${join(homedir(), 'pa-escaped.txt')} || echo blocked-home >&2`,
      'echo out > /var/tmp/pa-escaped.txt || echo blocked-var-tmp >&2',
      'echo private > /tmp/pa-private.txt && echo tmp-ok >&2',
    ].join('\n');
    const result = await runCase('bwrap', ['sh', '-c', script]);
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

  it('a case reads its fixtures and runs as the calling user', async () => {
    writeFileSync(join(workdir, 'in.txt'), 'b\na\n');
    const uid = String(process.getuid!());
    for (const kind of ['bwrap', 'unshare', 'none'] as const) {
      const result = await runCase(kind, ['sh', '-c', 'sort in.txt; id -u']);
      expect(result.stdout, kind).toBe(`a\nb\n${uid}\n`);
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

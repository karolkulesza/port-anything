import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseSandbox, probeSandbox, sandboxCommand, type SandboxSetup } from '../src/sandbox.js';

// sandbox-exec ships with macOS, so these run on every Mac and on the macOS CI runners.
describe.runIf(process.platform === 'darwin')('local sandbox (macOS)', () => {
  const SEATBELT: SandboxSetup = { kind: 'sandbox-exec' };
  const NONE: SandboxSetup = { kind: 'none' };
  let root: string;
  let workdir: string;
  let server: Server;
  let port: number;
  let unixServer: Server;
  let unixPath: string;

  beforeAll(async () => {
    // tmpdir() is under /var, a symlink to /private/var: the workdir is passed unresolved on purpose.
    root = mkdtempSync(join(tmpdir(), 'pa-sandbox-'));
    workdir = join(root, 'case');
    mkdirSync(workdir);
    mkdirSync(join(root, 'outside'));
    server = createServer((socket) => socket.end('hello\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    // A service socket outside the workdir, like an SSH agent's.
    unixPath = join(root, 'service.sock');
    unixServer = createServer((socket) => socket.end('hello\n'));
    await new Promise<void>((resolve) => unixServer.listen(unixPath, resolve));
  });

  afterAll(() => {
    server.close();
    unixServer.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Async, so the test servers in this process can answer while the case runs.
  function runCase(setup: SandboxSetup, argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const { command, args, cwd } = sandboxCommand(setup, argv, workdir);
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  // Connects to a test server: exit 0 if it answers, 1 on any error.
  const connect = (target: string) => [
    process.execPath,
    '-e',
    `require('net').connect(${target}).on('data', () => process.exit(0)).on('error', (e) => { console.error(e.code); process.exit(1); })`,
  ];

  it('the probe finds sandbox-exec', async () => {
    const probe = await probeSandbox();
    expect(probe.attempts).toEqual([{ kind: 'sandbox-exec', ok: true }]);
    expect(chooseSandbox(probe)).toEqual({ kind: 'sandbox-exec', label: 'sandbox-exec, no network' });
  });

  it('a case that opens a TCP socket fails (and works without the sandbox)', async () => {
    const tcp = connect(`${port}, '127.0.0.1'`);
    expect((await runCase(NONE, tcp)).status).toBe(0);
    const result = await runCase(SEATBELT, tcp);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/EPERM/);
  });

  it('a case that connects to a Unix socket outside its workdir fails', async () => {
    const unix = connect(JSON.stringify(unixPath));
    expect((await runCase(NONE, unix)).status).toBe(0);
    const result = await runCase(SEATBELT, unix);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/EPERM/);
  });

  it('a case that writes outside its workdir fails, and writes inside it work', async () => {
    const home = join(homedir(), `pa-escaped-${process.pid}.txt`);
    const tmp = `/tmp/pa-escaped-${process.pid}.txt`;
    const script = [
      'echo in > result.txt',
      'mkdir sub && echo x > sub/f && mv sub/f moved.txt && chmod 600 moved.txt && rm moved.txt && rmdir sub && echo fs-ok >&2',
      'echo out > ../outside/escaped.txt || echo blocked-sibling >&2',
      `echo out > ${home} || echo blocked-home >&2`,
      `echo out > ${tmp} || echo blocked-tmp >&2`,
      // Pipes and the standard devices stay writable.
      'echo quiet > /dev/null && echo devnull-ok >&2',
      'echo to-stderr > /dev/stderr && echo to-fd > /dev/fd/2',
    ].join('\n');
    const result = await runCase(SEATBELT, ['sh', '-c', script]);
    expect(result.status, result.stderr).toBe(0);
    for (const line of ['fs-ok', 'blocked-sibling', 'blocked-home', 'blocked-tmp', 'devnull-ok', 'to-stderr', 'to-fd']) {
      expect(result.stderr).toContain(line);
    }
    expect(readFileSync(join(workdir, 'result.txt'), 'utf8')).toBe('in\n');
    expect(existsSync(join(root, 'outside', 'escaped.txt'))).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(tmp)).toBe(false);
  });

  it("a case can't reach an outside file through a hard link or a symlink in its workdir", async () => {
    const victim = join(root, 'outside', 'victim.txt');
    writeFileSync(victim, 'original\n');
    const script = [
      `ln ${victim} hard.txt || echo blocked-hardlink >&2`,
      `ln -s ${victim} soft.txt && { echo changed >> soft.txt || echo blocked-symlink >&2; }`,
    ].join('\n');
    const result = await runCase(SEATBELT, ['sh', '-c', script]);
    expect(result.stderr).toContain('blocked-hardlink');
    expect(result.stderr).toContain('blocked-symlink');
    expect(readFileSync(victim, 'utf8')).toBe('original\n');
  });

  it("a case can't write the user's preferences through cfprefsd", async () => {
    // The preferences daemon writes ~/Library/Preferences for the caller, outside any sandbox.
    const domain = `dev.port-anything.test-${process.pid}`;
    const plist = join(homedir(), 'Library', 'Preferences', `${domain}.plist`);
    try {
      await runCase(SEATBELT, ['defaults', 'write', domain, 'key', 'value']);
      expect(existsSync(plist)).toBe(false);
    } finally {
      rmSync(plist, { force: true });
    }
  });

  it("a case can't signal the user's other processes, but can signal its own", async () => {
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const script = `kill -9 ${victim.pid} && echo killed; sleep 30 & kill $! && echo own-ok`;
      const result = await runCase(SEATBELT, ['sh', '-c', script]);
      expect(result.stdout).not.toContain('killed');
      expect(result.stdout).toContain('own-ok');
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
      expect(process.kill(victim.pid!, 0)).toBe(true);
    } finally {
      victim.kill('SIGKILL');
    }
  });

  it('a case reads its fixtures, writes its outputs, and keeps its exit code', async () => {
    writeFileSync(join(workdir, 'in.txt'), 'b\na\n');
    const result = await runCase(SEATBELT, ['sh', '-c', 'sort in.txt | tee out.txt; id -u; exit 3']);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe(`a\nb\n${process.getuid!()}\n`);
    expect(readFileSync(join(workdir, 'out.txt'), 'utf8')).toBe('a\nb\n');
  });

  it('resolves the workdir, so the profile matches the path the kernel sees', () => {
    expect(workdir).not.toBe(realpathSync(workdir)); // /var/... vs /private/var/...
    expect(sandboxCommand(SEATBELT, ['true'], workdir).args).toContain(`WORKDIR=${realpathSync(workdir)}`);
  });
});

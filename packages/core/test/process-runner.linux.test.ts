import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseEnvironment, runProcess } from '../src/process-runner.js';
import type { SandboxSetup } from '../src/sandbox.js';

// The runner inside each local sandbox. Runs in the dev container: scripts/dev-linux.sh pnpm -r test
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('process runner in the local sandbox (Linux)', () => {
  let workdir: string;
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'pa-runner-linux-'));
  });
  afterAll(() => rmSync(workdir, { recursive: true, force: true }));

  const SETUPS: SandboxSetup[] = [
    { kind: 'bwrap', isolatePids: true },
    { kind: 'bwrap', isolatePids: false },
    { kind: 'unshare', mapCurrentUser: true },
    { kind: 'unshare', mapCurrentUser: false },
  ];

  const run = (sandbox: SandboxSetup, argv: string[], extra: { timeoutMs?: number; outputCapBytes?: number } = {}) =>
    runProcess({ argv, cwd: workdir, env: caseEnvironment({ home: workdir }), sandbox, ...extra });

  // Processes on the host whose command line is exactly this.
  const running = (cmdline: string) => {
    try {
      return execFileSync('pgrep', ['-fx', cmdline], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };

  it.each(SETUPS)('a sleep case times out and is killed, with what it started (%j)', async (sandbox) => {
    const started = Date.now();
    const r = await run(sandbox, ['sh', '-c', 'sleep 37 & sleep 38'], { timeoutMs: 300 });
    expect(r.timeout).toBe(true);
    expect(r.exit === null ? r.signal : r.exit).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Give the kernel a moment to deliver the last signals.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(running('sleep 37')).toBe('');
    expect(running('sleep 38')).toBe('');
  });

  it.each(SETUPS)('an output flood is capped (%j)', async (sandbox) => {
    const r = await run(sandbox, ['yes'], { outputCapBytes: 65_536 });
    expect(r.stdout.length).toBe(65_536);
    expect(r.truncated.stdout).toBe(true);
    expect(r.timeout).toBe(false);
  });

  it.each(SETUPS)('env outside the allow-list is invisible (%j)', async (sandbox) => {
    process.env.PA_RUNNER_SECRET = 'hunter2';
    try {
      const r = await run(sandbox, ['env']);
      const names = r.stdout
        .toString()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.slice(0, line.indexOf('=')))
        .sort();
      expect(names).toEqual(['HOME', 'LANG', 'PATH', 'PWD', 'SOURCE_DATE_EPOCH', 'TZ']);
    } finally {
      delete process.env.PA_RUNNER_SECRET;
    }
  });

  it.each(SETUPS)('stdin is /dev/null by default and output goes to pipes (%j)', async (sandbox) => {
    const r = await run(sandbox, ['sh', '-c', 'cat; for fd in 0 1 2; do [ -t $fd ] && echo "tty $fd"; done; echo ok']);
    expect(r).toMatchObject({ exit: 0, timeout: false });
    expect(r.stdout.toString()).toBe('ok\n');
  });
});

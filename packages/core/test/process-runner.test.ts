import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalObservation } from '../src/model.js';
import {
  BASE_ENV_ALLOWLIST,
  DEFAULT_CASE_ENV,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  caseEnvironment,
  runProcess,
  type ProcessSpec,
} from '../src/process-runner.js';

describe('caseEnvironment', () => {
  const hostEnv = { PATH: '/usr/bin:/bin', COLUMNS: '80', SECRET_TOKEN: 'hunter2', LC_ALL: 'pl_PL.UTF-8', TZ: 'Europe/Warsaw' };

  it('keeps only allow-listed host variables, plus the fixed ones and HOME', () => {
    const env = caseEnvironment({ home: '/case/home', hostEnv, allowlist: ['COLUMNS', 'NO_COLOR'] });
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      COLUMNS: '80',
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      SOURCE_DATE_EPOCH: DEFAULT_CASE_ENV.SOURCE_DATE_EPOCH,
      HOME: '/case/home',
    });
  });

  it('passes PATH through by default and nothing else', () => {
    expect(BASE_ENV_ALLOWLIST).toEqual(['PATH']);
    const env = caseEnvironment({ home: '/h', hostEnv });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'SOURCE_DATE_EPOCH', 'TZ']);
  });

  it('the fixed defaults win over an allow-listed host value; configured values win over the defaults', () => {
    expect(caseEnvironment({ home: '/h', hostEnv, allowlist: ['TZ'] }).TZ).toBe('UTC');
    const env = caseEnvironment({ home: '/h', hostEnv, env: { LANG: 'en_US.UTF-8', SOURCE_DATE_EPOCH: '1' } });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.SOURCE_DATE_EPOCH).toBe('1');
  });

  it("the case's own variables win over everything except HOME", () => {
    const env = caseEnvironment({ home: '/h', hostEnv, caseEnv: { TZ: 'Asia/Tokyo', COLUMNS: '120', HOME: '/root' } });
    expect(env.TZ).toBe('Asia/Tokyo');
    expect(env.COLUMNS).toBe('120');
    expect(env.HOME).toBe('/h');
  });

  it('skips allow-listed names the host does not set', () => {
    expect(caseEnvironment({ home: '/h', hostEnv: {}, allowlist: ['NO_COLOR'] })).not.toHaveProperty('NO_COLOR');
  });
});

describe('runProcess (no sandbox)', () => {
  let workdir: string;
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'pa-runner-'));
  });
  afterAll(() => rmSync(workdir, { recursive: true, force: true }));

  const run = (argv: string[], spec: Partial<ProcessSpec> = {}) =>
    runProcess({
      argv,
      cwd: workdir,
      env: caseEnvironment({ home: workdir }),
      sandbox: { kind: 'none' },
      ...spec,
    });

  it('has the plan defaults: 10 s timeout, 16 MB per stream', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_OUTPUT_CAP_BYTES).toBe(16 * 1024 * 1024);
  });

  it('captures stdout, stderr and the exit code separately', async () => {
    const r = await run(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(r).toMatchObject({ exit: 3, signal: null, timeout: false, truncated: { stdout: false, stderr: false } });
    expect(r.stdout.toString()).toBe('out\n');
    expect(r.stderr.toString()).toBe('err\n');
    expect(r.time_ms.wall).toBeGreaterThan(0);
  });

  it('captures the signal that ended the process', async () => {
    const r = await run(['sh', '-c', 'kill -SEGV $$']);
    expect(r).toMatchObject({ exit: null, signal: 'SIGSEGV', timeout: false });
  });

  it('a sleep case times out and is killed', async () => {
    const started = Date.now();
    const r = await run(['sleep', '30'], { timeoutMs: 300 });
    expect(r).toMatchObject({ exit: null, signal: 'SIGTERM', timeout: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a case that ignores SIGTERM is killed with SIGKILL after the grace period', async () => {
    const started = Date.now();
    const r = await run(['sh', '-c', 'trap "" TERM; echo ready; while :; do sleep 1; done'], { timeoutMs: 300, killGraceMs: 300 });
    expect(r).toMatchObject({ exit: null, signal: 'SIGKILL', timeout: true });
    expect(r.stdout.toString()).toBe('ready\n');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the timeout also kills the case's child processes", async () => {
    // If the inner sleep survived, it would hold stdout open and the run would never finish.
    const started = Date.now();
    const r = await run(['sh', '-c', 'sleep 30; echo never'], { timeoutMs: 300 });
    expect(r.timeout).toBe(true);
    expect(r.stdout.toString()).toBe('');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('background processes left behind when the case exits are killed', async () => {
    const started = Date.now();
    const r = await run(['sh', '-c', 'sleep 30 & echo done']);
    expect(r).toMatchObject({ exit: 0, timeout: false });
    expect(r.stdout.toString()).toBe('done\n');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('an output flood is capped and the case is stopped', async () => {
    const cap = 1024 * 1024;
    const started = Date.now();
    const r = await run(['yes', 'flood'], { outputCapBytes: cap, timeoutMs: 10_000 });
    expect(r.stdout.length).toBe(cap);
    expect(r.stdout.subarray(0, 12).toString()).toBe('flood\nflood\n');
    expect(r.truncated).toEqual({ stdout: true, stderr: false });
    expect(r.timeout).toBe(false);
    expect(r.signal).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('caps stderr on its own', async () => {
    const r = await run(['sh', '-c', 'echo ok; yes err >&2'], { outputCapBytes: 4096 });
    expect(r.stdout.toString()).toBe('ok\n');
    expect(r.stderr.length).toBe(4096);
    expect(r.truncated).toEqual({ stdout: false, stderr: true });
  });

  it('output exactly at the cap is not truncated', async () => {
    const r = await run(['sh', '-c', 'printf 12345678'], { outputCapBytes: 8 });
    expect(r.stdout.toString()).toBe('12345678');
    expect(r.truncated.stdout).toBe(false);
    expect(r.exit).toBe(0);
  });

  it('env outside the allow-list is invisible to the case', async () => {
    process.env.PA_RUNNER_SECRET = 'hunter2';
    process.env.PA_RUNNER_ALLOWED = 'yes';
    try {
      const r = await run(['env'], {
        env: caseEnvironment({ home: join(workdir, 'home'), allowlist: ['PA_RUNNER_ALLOWED'] }),
      });
      const seen = Object.fromEntries(
        r.stdout
          .toString()
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      expect(seen).not.toHaveProperty('PA_RUNNER_SECRET');
      expect(seen.PA_RUNNER_ALLOWED).toBe('yes');
      expect(seen).toMatchObject({ TZ: 'UTC', LANG: 'C.UTF-8', SOURCE_DATE_EPOCH: DEFAULT_CASE_ENV.SOURCE_DATE_EPOCH, HOME: join(workdir, 'home') });
      // Only what caseEnvironment produced, plus PWD.
      expect(Object.keys(seen).sort()).toEqual(['HOME', 'LANG', 'PATH', 'PA_RUNNER_ALLOWED', 'PWD', 'SOURCE_DATE_EPOCH', 'TZ']);
      expect(seen.PWD).toBe(workdir);
    } finally {
      delete process.env.PA_RUNNER_SECRET;
      delete process.env.PA_RUNNER_ALLOWED;
    }
  });

  it('stdin is /dev/null by default, so a filter with no input ends at once', async () => {
    const r = await run(['sort'], { timeoutMs: 5_000 });
    expect(r).toMatchObject({ exit: 0, timeout: false });
    expect(r.stdout.length).toBe(0);
    const devNull = await run(['sh', '-c', '[ /dev/stdin -ef /dev/null ] && echo devnull']);
    expect(devNull.stdout.toString()).toBe('devnull\n');
  });

  it('feeds stdin bytes when the case has them', async () => {
    const r = await run(['sort'], { stdin: Buffer.from('b\na\n') });
    expect(r.stdout.toString()).toBe('a\nb\n');
  });

  it("doesn't fail when the case exits without reading a large stdin", async () => {
    const r = await run(['true'], { stdin: Buffer.alloc(4 * 1024 * 1024, 'x') });
    expect(r).toMatchObject({ exit: 0, signal: null, timeout: false });
  });

  it('stdin, stdout and stderr are never a terminal', async () => {
    const r = await run(['sh', '-c', 'for fd in 0 1 2; do [ -t $fd ] && echo "tty $fd"; done; echo checked']);
    expect(r.stdout.toString()).toBe('checked\n');
  });

  it('runs in the given working directory', async () => {
    const r = await run(['pwd', '-P']);
    expect(r.stdout.toString().trim()).toBe(realpathSync(workdir));
  });

  it('stops waiting for output held open by a process that left the case\'s process group', async () => {
    const started = Date.now();
    const escape = `require('child_process').spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref()`;
    const r = await run([process.execPath, '-e', escape], { killGraceMs: 300 });
    expect(r).toMatchObject({ exit: 0, timeout: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a program that does not exist as an error, not a case result', async () => {
    await expect(run(['pa-no-such-program-xyz'])).rejects.toThrow(/pa-no-such-program-xyz/);
  });

  it('reports CPU time and peak RSS as not measured, in the shape observations store', async () => {
    const r = await run(['true']);
    expect(r.time_ms.user).toBeNull();
    expect(r.time_ms.sys).toBeNull();
    expect(r.rss_kb).toBeNull();
    const ref = (c: string) => `blob:sha256:${c.repeat(64)}`;
    const observation = {
      exit: r.exit,
      signal: r.signal,
      timeout: r.timeout,
      stdout: ref('1'),
      stderr: ref('2'),
      fs: { created: {}, modified: {}, deleted: [] },
      time_ms: r.time_ms,
      rss_kb: r.rss_kb,
      runs: 1,
      stable: true,
    };
    expect(() => canonicalObservation(observation)).not.toThrow();
  });
});


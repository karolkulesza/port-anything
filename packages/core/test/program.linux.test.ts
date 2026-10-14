import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseEnvironment, runProcess, type ProcessResult } from '../src/process-runner.js';
import { parseProgramCommand, pinPrograms, pinnedProcess, resolveProgram } from '../src/program.js';
import type { SandboxSetup } from '../src/sandbox.js';

// Pinned argv[0] with real GNU and uutils tools. Runs in the dev container (Ubuntu 25.10: uutils is
// /usr/bin/sort, GNU sort is /usr/bin/gnusort): scripts/dev-linux.sh pnpm -r test
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('argv[0] pinning (Linux)', () => {
  let root: string;
  let work: string;
  beforeAll(() => {
    // Under /tmp on purpose: bwrap hides the host's /tmp, so the pinned files must be shown to it.
    root = mkdtempSync(join(tmpdir(), 'pa-pin-linux-'));
    work = join(root, 'work');
    mkdirSync(work);
    mkdirSync(join(root, 'copies'));
    copyFileSync('/usr/bin/gnusort', join(root, 'copies', 'othersort'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const SETUPS: SandboxSetup[] = [
    { kind: 'bwrap', isolatePids: true },
    { kind: 'unshare', mapCurrentUser: true },
    { kind: 'none' },
  ];

  const ERROR_CASES = [
    ['--no-such-option'],
    ['-k'],
    ['-k', '0'],
    ['-t', 'ab'],
    ['--sort=sideways'],
    ['-S', 'lots'],
    ['missing-file'],
    ['-c', 'missing-file'],
  ];

  const observed = (r: ProcessResult) => ({ exit: r.exit, signal: r.signal, stdout: r.stdout.toString(), stderr: r.stderr.toString() });

  it.each(SETUPS)('an identical copy under another name gives 100%% parity on error cases (%j)', async (sandbox) => {
    const ref = await resolveProgram(parseProgramCommand('/usr/bin/gnusort'));
    const cand = await resolveProgram(parseProgramCommand(join(root, 'copies', 'othersort')));
    const { name, sides } = await pinPrograms(join(root, `pin-copy-${sandbox.kind}`), [ref, cand]);
    expect(name).toBe('gnusort');
    const env = caseEnvironment({ home: work });
    let matching = 0;
    for (const argv of ERROR_CASES) {
      const [r, c] = await Promise.all(sides.map((side) => runProcess({ ...pinnedProcess(name, side, argv, env), cwd: work, sandbox })));
      expect(r!.exit).not.toBe(0);
      expect(r!.stderr.toString()).toMatch(/^gnusort: /);
      if (JSON.stringify(observed(r!)) === JSON.stringify(observed(c!))) matching++;
      else expect(observed(c!)).toEqual(observed(r!));
    }
    expect(matching / ERROR_CASES.length).toBe(1);

    // Control: run by their own paths, the copy names itself differently on every case.
    const unpinned = await Promise.all(
      ['/usr/bin/gnusort', join(root, 'copies', 'othersort')].map((path) =>
        runProcess({ argv: [path, '--no-such-option'], cwd: work, env, sandbox, readOnlyPaths: [join(root, 'copies')] }),
      ),
    );
    expect(unpinned[1]!.stderr.toString()).toContain('othersort');
    expect(unpinned[0]!.stderr.toString()).not.toBe(unpinned[1]!.stderr.toString());
  });

  it.each(SETUPS)("the uutils multicall binary runs as sort from 'coreutils sort' (%j)", async (sandbox) => {
    const multicall = await resolveProgram(parseProgramCommand('coreutils sort'));
    expect(multicall.tool).toBe('sort');
    const { name, sides } = await pinPrograms(join(root, `pin-multi-${sandbox.kind}`), [multicall]);
    expect(name).toBe('sort');
    const env = caseEnvironment({ home: work });
    const run = (argv: string[], stdin?: string) =>
      runProcess({ ...pinnedProcess(name, sides[0]!, argv, env), cwd: work, sandbox, stdin: stdin === undefined ? null : Buffer.from(stdin) });

    const sorted = await run(['-r'], 'a\nc\nb\n');
    expect(observed(sorted)).toEqual({ exit: 0, signal: null, stdout: 'c\nb\na\n', stderr: '' });
    const missing = await run(['missing-file']);
    expect(missing.exit).toBe(2);
    expect(missing.stderr.toString()).toBe('sort: cannot read: missing-file: No such file or directory\n');
    const usage = await run(['--no-such-option']);
    expect(usage.stderr.toString()).toContain('Usage: sort [OPTION]...');
    expect(usage.stderr.toString()).not.toContain('coreutils');
  });

  it('GNU sort and the uutils multicall both run as sort and name themselves the same way', async () => {
    const programs = [await resolveProgram(parseProgramCommand('/usr/bin/gnusort')), await resolveProgram(parseProgramCommand('coreutils sort'))];
    const { name, sides } = await pinPrograms(join(root, 'pin-both'), programs);
    expect(name).toBe('sort');
    const env = caseEnvironment({ home: work });
    const sandbox: SandboxSetup = { kind: 'bwrap', isolatePids: true };
    const [gnu, uu] = await Promise.all(sides.map((side) => runProcess({ ...pinnedProcess(name, side, ['missing-file'], env), cwd: work, sandbox })));
    expect(gnu!.stderr.toString()).toBe('sort: cannot read: missing-file: No such file or directory\n');
    expect(uu!.stderr.toString()).toBe(gnu!.stderr.toString());
  });
});

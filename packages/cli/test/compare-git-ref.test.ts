import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSandbox, type SandboxProbe } from '@port-anything/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCommand, parseCompareArgs, type CompareSummary } from '../src/compare-command.js';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
// A small tool whose --upper upper-cases the input; the `ignores-upper` version is the behavior
// change a refactor might bring in.
const TOOL = (version: 'v1' | 'ignores-upper') => `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -u, --upper     upper-case the output\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) ;;
    -u|--upper) upper=${version === 'v1' ? '1' : ''} ;;
    --) shift; break ;;
    -?*) echo "frob: unrecognized option '$1'" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
cat "$@" | if [ -n "$upper" ]; then tr 'a-z' 'A-Z'; else cat; fi
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('parseCompareArgs --ref', () => {
  it('takes git:<rev>, and every positional is then a candidate', () => {
    expect(parseCompareArgs(['--ref', 'git:HEAD~1', './bin/tool'])).toEqual({
      reference: 'git:HEAD~1',
      gitRev: 'HEAD~1',
      candidates: ['./bin/tool'],
      budget: 500,
      save: false,
      json: false,
      iKnow: false,
      noSandbox: false,
    });
    expect(parseCompareArgs(['./a', './b', '--ref=git:v1.2.0']).candidates).toEqual(['./a', './b']);
  });

  it('refuses another kind of reference, no candidate, and --save', () => {
    expect(() => parseCompareArgs(['--ref', 'HEAD~1', './bin/tool'])).toThrow(/--ref takes git:<rev>.*got "HEAD~1"\.\nUsage: port-anything compare '<ref cmd>'[^\n]*\n {7}port-anything compare --ref git:<rev>/);
    expect(() => parseCompareArgs(['--ref', 'git:', './bin/tool'])).toThrow(/--ref takes git:<rev>/);
    expect(() => parseCompareArgs(['--ref', 'git:HEAD'])).toThrow(/compare --ref needs at least one candidate/);
    expect(() => parseCompareArgs(['--ref', 'git:HEAD', './bin/tool', '--save'])).toThrow(/--save can't record a git reference/);
  });
});

describe('port-anything compare --ref git:<rev>', { timeout: 120_000 }, () => {
  let repo: string;
  let scratch: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();
  const commit = (message: string) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
  };
  const write = (path: string, content: string, mode = 0o644) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content, { mode });
  };

  beforeEach(() => {
    // Not in /tmp on Linux: bwrap hides it, and the sandboxed test needs the repository visible.
    repo = realpathSync(mkdtempSync(join(process.platform === 'linux' ? '/var/tmp' : tmpdir(), 'pa-git-ref-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pa-git-ref-scratch-')));
    git(repo, 'init', '-q');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  const compare = (args: string[], cwd = repo, progress?: (line: string) => void) =>
    compareCommand([...args, '--no-sandbox'], { cwd, probe: NO_SANDBOX, tmpDir: scratch, concurrency: 2, ...(progress === undefined ? {} : { progress }) });
  const json = async (args: string[], cwd = repo) => {
    const result = await compare([...args, '--json'], cwd);
    expect(result.stderr).toBe('');
    return { exitCode: result.exitCode, summary: JSON.parse(result.stdout) as CompareSummary };
  };
  /** Only the main working tree is left, and no scratch files. */
  const expectCleanedUp = () => {
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(readdirSync(join(repo, '.git')).filter((f) => f.startsWith('port-anything'))).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
  };

  it('finds the behavior change between two commits of a tracked script, and none against the same commit', async () => {
    write('tool/frob', TOOL('v1'), 0o755);
    commit('v1');
    write('tool/frob', TOOL('ignores-upper'), 0o755);
    commit('refactor');

    const changed = await json(['--ref', 'git:HEAD~1', './tool/frob', '--budget', '60']);
    expect(changed.exitCode).toBe(1);
    expect(changed.summary).toMatchObject({
      reference: 'git:HEAD~1',
      git: { rev: 'HEAD~1', commit: git(repo, 'rev-parse', 'HEAD~1'), cmd: './tool/frob', build: null },
      program_name: 'frob',
    });
    const [candidate] = changed.summary.candidates;
    expect(candidate!.divergences.length).toBeGreaterThan(0);
    // Only cases with --upper (or -u) diverge. (tr may also fail on a mutated non-UTF-8 input.)
    for (const d of candidate!.divergences) expect(d.argv.some((a) => a === '--upper' || /^-[a-z]*u/.test(a))).toBe(true);
    expect(candidate!.per_feature.find((f) => f.feature === 'opt.upper')!.parity).toBeLessThan(1);
    expect(candidate!.per_feature.find((f) => f.feature === 'base')!.parity).toBe(1); // no flags: no change
    expectCleanedUp();

    const same = await json(['--ref', 'git:HEAD', './tool/frob', '--budget', '60']);
    expect(same.exitCode).toBe(0);
    expect(same.summary.candidates[0]).toMatchObject({ parity: 1, divergences: [] });
    expectCleanedUp();
  });

  it('compares uncommitted changes against the last commit, leaving the working copy as it was', async () => {
    write('tool/frob', TOOL('v1'), 0o755);
    commit('v1');
    write('tool/frob', TOOL('ignores-upper'), 0o755);
    const before = git(repo, 'status', '--porcelain');
    expect(before).toBe('M tool/frob');

    const { exitCode, summary } = await json(['--ref', 'git:HEAD', './tool/frob', '--budget', '60']);
    expect(exitCode).toBe(1);
    expect(summary.candidates[0]!.divergences.length).toBeGreaterThan(0);
    expect(git(repo, 'status', '--porcelain')).toBe(before);
    expect(git(repo, 'branch', '--list')).not.toMatch(/\n/); // no branch created
    expectCleanedUp();
  });

  it('runs reference.build in the checkout, from the project directory inside the repository, and prints where the reference came from', async () => {
    // The project lives in proj/; the build copies the source to proj/bin, which git ignores.
    write('proj/src/frob.sh', TOOL('v1'));
    write('proj/.gitignore', 'bin/\n');
    write('proj/port-anything.yaml', 'version: 1\nreference:\n  cmd: ./bin/frob\n  build: mkdir -p bin && cp src/frob.sh bin/frob && chmod +x bin/frob\ncandidate:\n  cmd: ./bin/frob\n');
    commit('v1');
    write('proj/src/frob.sh', TOOL('ignores-upper'));
    commit('refactor');
    const proj = join(repo, 'proj');
    execFileSync('sh', ['-c', 'mkdir -p bin && cp src/frob.sh bin/frob && chmod +x bin/frob'], { cwd: proj });

    const lines: string[] = [];
    const result = await compare(['--ref', 'git:HEAD~1', './bin/frob', '--budget', '60'], proj, (line) => lines.push(line));
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
    const short = git(repo, 'rev-parse', '--short=7', 'HEAD~1');
    expect(result.stdout.split('\n')[0]).toBe(`reference: ./bin/frob at git:HEAD~1 (${short}), built with \`mkdir -p bin && cp src/frob.sh bin/frob && chmod +x bin/frob\``);
    expect(result.stdout).toMatch(/^\.\/bin\/frob: parity \d+\.\d% /m);
    expect(lines[0]).toBe(`building git:HEAD~1 (${short}) in a temporary worktree …`);
    expect(lines[1]).toBe('reading frob --help …');
    expectCleanedUp();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses a revision that names no commit, a directory outside a repository, and a failed build, with exit 3', async () => {
    write('tool/frob', TOOL('v1'), 0o755);
    commit('v1');

    const rev = await compare(['--ref', 'git:no-such-branch', './tool/frob']);
    expect(rev).toMatchObject({ exitCode: 3, stdout: '' });
    expect(rev.stderr).toMatch(/--ref git:no-such-branch: "no-such-branch" names no commit/);
    const option = await compare(['--ref', 'git:--all', './tool/frob']);
    expect(option.stderr).toMatch(/"--all" names no commit/);

    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pa-git-ref-norepo-')));
    try {
      writeFileSync(join(outside, 'frob'), TOOL('v1'), { mode: 0o755 });
      const notRepo = await compare(['--ref', 'git:HEAD', './frob'], outside);
      expect(notRepo.exitCode).toBe(3);
      expect(notRepo.stderr).toMatch(/needs a git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    write('port-anything.yaml', 'version: 1\nreference:\n  cmd: ./tool/frob\n  build: \'echo compiling; echo "error: it broke" >&2; exit 7\'\n');
    const build = await compare(['--ref', 'git:HEAD', './tool/frob']);
    expect(build.exitCode).toBe(3);
    expect(build.stderr).toMatch(/reference\.build failed \(exit code 7\): echo compiling[^\n]*\n {2}compiling\n {2}error: it broke\n$/);
    expectCleanedUp();
  });

  it('refuses a reference the commit has no file for, or one outside the repository', async () => {
    write('tool/frob', TOOL('v1'), 0o755);
    commit('v1');
    write('tool/new-frob', TOOL('v1'), 0o755);

    const missing = await compare(['--ref', 'git:HEAD', './tool/new-frob']);
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toMatch(/new-frob not found in the checkout of git:HEAD \(no reference\.build in port-anything\.yaml ran there\)\./);

    const onPath = await compare(['--ref', 'git:HEAD', 'cat']);
    expect(onPath.exitCode).toBe(3);
    expect(onPath.stderr).toMatch(/The reference cat is .*cat, outside the repository, so it is the same program at every commit/);
    expectCleanedUp();
  });

  it('turns an absolute path into the repository into the same path in the checkout', async () => {
    write('tool/frob', TOOL('v1'), 0o755);
    commit('v1');
    write('tool/frob', TOOL('ignores-upper'), 0o755);
    const { exitCode, summary } = await json(['--ref', 'git:HEAD', join(repo, 'tool/frob'), '--budget', '40']);
    expect(exitCode).toBe(1);
    expect(summary.git!.cmd).toBe(join(repo, 'tool/frob'));
  });

  // The reference is a wrapper that runs a script next to its real path, so the sandbox must show
  // the whole checkout, not only the program file, on both sides.
  it.runIf(process.platform === 'darwin' || (process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1'))('runs the checked-out reference in the sandbox, with the files next to it', async () => {
    write('tool/frob', '#!/bin/sh\nexec sh "$(dirname "$(readlink -f "$0")")/frob-impl.sh" "$@"\n', 0o755);
    write('tool/frob-impl.sh', TOOL('v1'));
    commit('v1');
    write('tool/frob-impl.sh', TOOL('ignores-upper'));
    commit('refactor');
    const probe = await probeSandbox();
    expect(probe.usable).toBeDefined();
    const result = await compareCommand(['--ref', 'git:HEAD~1', './tool/frob', '--budget', '40', '--json'], { cwd: repo, probe, tmpDir: scratch, concurrency: 2 });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
    const summary = JSON.parse(result.stdout) as CompareSummary;
    expect(summary.sandbox).toMatch(/^(bwrap|unshare|sandbox-exec)/);
    expect(summary.candidates[0]!.per_feature.find((f) => f.feature === 'opt.upper')!.parity).toBeLessThan(1);
    expect(summary.candidates[0]!.per_feature.find((f) => f.feature === 'base')!.parity).toBe(1);
    expectCleanedUp();
  });

  it('is reachable from the command line', async () => {
    write('tool/frob', TOOL('v1'), 0o755);
    commit('v1');
    const result = await run(['compare', '--ref', 'git:HEAD', './tool/frob', '--budget', '10', '--no-sandbox', '--json'], { cwd: repo });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).git.rev).toBe('HEAD');
  });
});

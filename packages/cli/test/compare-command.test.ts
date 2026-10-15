import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_SPEC_FILE, readCliSpecFile, readConfigFile, type SandboxProbe } from '@port-anything/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCommand, formatCompare, parseCompareArgs, percent, scoreParity, type CompareSummary, type FeatureParity } from '../src/compare-command.js';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
// `bad` ignores --upper; `flaky` prints a random number with --quiet; `lucky` prints only `heads`
// with --quiet, except on the 4th run of the same argv and input (counted in the `state` directory
// given to `TOOL`; none: always `heads`), where it prints `tails`: output that varies by chance but agreed in the
// generator's and both baseline runs, like `sort --random-sort` on two lines; `pwd` prints its working directory with --quiet, which differs between runs and is what the tmp-paths normalizer covers. Every stage of the pipeline
// reads all its input (awk, not head), so no write ever fails on a closed pipe at random.
const TOOL = (variant: 'ref' | 'bad' | 'flaky' | 'lucky' | 'pwd', state = '') => `#!/bin/sh
argv="$*"
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -u, --upper     upper-case the output\\n  -n, --count=N   stop after N lines\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=; count=; quiet=
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) quiet=1 ;;
    -u|--upper) upper=${variant === 'bad' ? '' : '1'} ;;
    -n|--count) [ $# -ge 2 ] || { echo "frob: option '$1' requires an argument" >&2; exit 2; }; count=$2; shift ;;
    --count=*) count=\${1#--count=} ;;
    -n*) count=\${1#-n} ;;
    --) shift; break ;;
    -?*) echo "frob: unrecognized option '$1'" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
${
  variant === 'flaky'
    ? '[ -n "$quiet" ] && od -An -N4 -tu4 /dev/urandom'
    : variant === 'pwd'
      ? '[ -n "$quiet" ] && pwd'
      : variant === 'lucky'
        ? `if [ -n "$quiet" ]; then
  key="${state}/$({ printf '%s\\n' "$argv"; cat "$@" 2>/dev/null; } | cksum | cut -d' ' -f1)"
  n=$(cat "$key" 2>/dev/null || echo 0); [ -z "${state}" ] || echo $((n + 1)) > "$key"
  if [ -n "${state}" ] && [ "$n" = 3 ]; then echo tails; else echo heads; fi
  exit 0
fi`
        : ':'
}
case "$count" in ''|*[!0-9]*) [ -z "$count" ] || { echo "frob: invalid count '$count'" >&2; exit 2; } ;; esac
cat "$@" | if [ -n "$upper" ]; then tr 'a-z' 'A-Z'; else cat; fi | if [ -n "$count" ]; then awk -v n="$count" 'NR <= n'; else cat; fi
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('parseCompareArgs', () => {
  it('reads the reference, the candidates and the options', () => {
    expect(parseCompareArgs(['/usr/bin/sort', 'coreutils sort', 'busybox sort', '--budget', '50', '--save', '--json', '--i-know', '--no-sandbox'])).toEqual({
      reference: '/usr/bin/sort',
      candidates: ['coreutils sort', 'busybox sort'],
      budget: 50,
      save: true,
      json: true,
      iKnow: true,
      noSandbox: true,
    });
    expect(parseCompareArgs(['a', 'b'])).toEqual({ reference: 'a', candidates: ['b'], budget: 500, save: false, json: false, iKnow: false, noSandbox: false });
  });

  it('needs a reference and a candidate, a whole budget, and no unknown options', () => {
    expect(() => parseCompareArgs([])).toThrow(/needs a reference and at least one candidate/);
    expect(() => parseCompareArgs(['a'])).toThrow(/needs a reference and at least one candidate/);
    expect(() => parseCompareArgs(['a', 'b', '--budget', '0'])).toThrow(/--budget must be a whole number of at least 1, got "0"/);
    expect(() => parseCompareArgs(['a', 'b', '--budget', '1.5'])).toThrow(/--budget must be/);
    expect(() => parseCompareArgs(['a', 'b', '--frobnicate'])).toThrow(/frobnicate[\s\S]*Usage: port-anything compare/);
  });
});

describe('scoreParity', () => {
  const self = new Set(['opt.help']);
  const cases = (feature: string[], match: number, diverge: number) => [
    ...Array.from({ length: match }, () => ({ features: feature, match: true })),
    ...Array.from({ length: diverge }, () => ({ features: feature, match: false })),
  ];

  it('averages per-feature parity, counting a case in each of its features and untagged cases only in the totals', () => {
    const score = scoreParity([...cases(['opt.a'], 2, 2), ...cases(['base'], 4, 0), ...cases(['opt.a', 'opt.b'], 1, 0), ...cases([], 0, 3)], self, 2);
    expect(score.per_feature.map((f) => [f.feature, f.match, f.cases])).toEqual([
      ['base', 4, 4],
      ['opt.a', 3, 5],
      ['opt.b', 1, 1],
    ]);
    // opt.b has one case, under the minimum of 2: shown, left out of the headline.
    expect(score.per_feature.find((f) => f.feature === 'opt.b')!.underSampled).toBe(true);
    expect(score.parity).toBeCloseTo((1 + 3 / 5) / 2);
    expect(score).toMatchObject({ features: 2, match: 7, cases: 12 });
  });

  it('leaves self-description features out of the headline, and has no headline without a qualifying feature', () => {
    const score = scoreParity([...cases(['opt.help'], 0, 30), ...cases(['opt.a'], 30, 0)], self);
    expect(score.parity).toBe(1);
    expect(score.per_feature.find((f) => f.feature === 'opt.help')).toMatchObject({ selfDescription: true, underSampled: false });
    expect(scoreParity(cases(['opt.a'], 3, 0), self).parity).toBeNull();
  });

  it('prints percentages rounded down, so one divergence never shows as 100%', () => {
    expect(percent(1)).toBe('100.0%');
    expect(percent(999 / 1000)).toBe('99.9%');
    expect(percent(9999 / 10000)).toBe('99.9%');
    expect(percent(0.914)).toBe('91.4%');
    expect(percent(0)).toBe('0.0%');
  });
});

// Each compare runs a few hundred cases of a shell script, so these take seconds each.
describe('formatCompare', () => {
  const feature = (name: string, match: number, cases: number, mark: Partial<FeatureParity> = {}): FeatureParity => ({
    feature: name,
    match,
    cases,
    parity: match / cases,
    selfDescription: false,
    underSampled: false,
    ...mark,
  });
  const summary: CompareSummary = {
    program_name: 'sort',
    sandbox: 'bwrap, no network',
    reference: '/usr/bin/sort',
    spec: { help: '--help', flags: 3, forms: 1, subcommands: 0, features: 4 },
    corpus: { cases: 60, budget: 60, generator: 'v1', seed: 42, stop: 'budget', observed: 70, dropped: { duplicate: 10, errorCap: 0, budget: 0 }, skipped: [] },
    untested: ['opt.z'],
    baseline: {
      repeats: 2,
      stable: 57,
      normalized: 2,
      flaky_reference: [{ case: `sha256:${'ab'.repeat(32)}`, argv: ['--random-sort', 'input file.txt'], fields: ['stdout'] }],
    },
    normalizers: [{ normalizer: 'tmp-paths on stderr', cases: 2 }],
    candidates: [
      { command: 'coreutils sort', parity: 1, features: 2, match: 59, cases: 59, divergences: [], per_feature: [feature('base', 20, 20), feature('opt.n', 39, 39), feature('opt.help', 1, 1, { selfDescription: true })] },
      {
        command: './my sort',
        parity: 0.9125,
        features: 2,
        match: 55,
        cases: 59,
        divergences: [],
        per_feature: [feature('base', 20, 20), feature('opt.n', 33, 40), feature('opt.help', 0, 1, { selfDescription: true }), feature('opt.r', 2, 3, { underSampled: true })],
      },
    ],
    saved: [],
    duration_ms: 12_400,
  };

  it('prints what was read and run, a parity line per candidate and the feature × candidate matrix', () => {
    expect(formatCompare(summary)).toBe(
      [
        'read "sort --help": 3 flags, 1 positional form',
        'every side runs as `sort` (argv[0] pinned) · sandbox: bwrap, no network',
        'generated 60 cases (budget 60)',
        'reference re-run 2× per case: 57 stable, 2 stable after normalizers, 1 flaky-reference (left out)',
        'normalizers (cases changed): tmp-paths on stderr 2',
        '',
        'coreutils sort: parity 100.0%  (mean of 2 features; 59/59 cases)',
        './my sort: parity 91.2%  (mean of 2 features; 55/59 cases)',
        '',
        '  feature                      cand 1        cand 2',
        '  base                         100.0% 20/20  100.0% 20/20',
        '  opt.help (self-description)  100.0% 1/1    0.0% 0/1',
        '  opt.n                        100.0% 39/39  82.5% 33/40',
        '  opt.r (under-sampled)        -             66.6% 2/3',
        'under-sampled: fewer than 20 cases, left out of the parity',
        'untested (no generated case): opt.z',
        '',
        'flaky-reference (output still varies between reference runs):',
        `  c_${'ab'.repeat(4)}  sort --random-sort 'input file.txt'  stdout`,
        '',
        'done in 12 s',
        '',
      ].join('\n'),
    );
  });

  it('has one parity column for one candidate, and says when no feature has enough cases or what was saved', () => {
    const one = { ...summary, untested: [], baseline: { ...summary.baseline, flaky_reference: [] }, normalizers: [], saved: ['port-anything.yaml', 'port-anything/cli-spec.yaml'] };
    one.candidates = [{ ...summary.candidates[0]!, parity: null, features: 0 }];
    const text = formatCompare(one);
    expect(text).toMatch(/^normalizers: none$/m);
    expect(text).toMatch(/^coreutils sort: parity n\/a \(no feature has enough cases\) {2}\(mean of 0 features; 59\/59 cases\)$/m);
    expect(text).toMatch(/^ {2}feature +parity$/m);
    expect(text).toMatch(/^saved port-anything\.yaml and port-anything\/cli-spec\.yaml$/m);
    expect(text).not.toMatch(/^flaky-reference \(/m);
  });
});

describe('port-anything compare', { timeout: 120_000 }, () => {
  let dir: string;
  let scratch: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-compare-')));
    scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    mkdirSync(join(dir, 'bin'));
    for (const [file, variant] of [['frob', 'ref'], ['frob-copy', 'ref'], ['frob-bad', 'bad'], ['frob-flaky', 'flaky'], ['frob-pwd', 'pwd'], ['frob-pwd-copy', 'pwd']] as const) {
      writeFileSync(join(dir, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'bin', 'frob-lucky'), TOOL('lucky', join(dir, 'state')), { mode: 0o755 });
    writeFileSync(join(dir, 'bin', 'frob-heads'), TOOL('lucky'), { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const compare = (args: string[], probe: SandboxProbe = NO_SANDBOX) => compareCommand(args, { cwd: dir, probe, tmpDir: scratch, concurrency: 2 });
  const json = async (args: string[]) => {
    const result = await compare([...args, '--json', '--no-sandbox']);
    expect(result.stderr).toBe('');
    return { exitCode: result.exitCode, summary: JSON.parse(result.stdout) as CompareSummary };
  };

  it('infers the spec, generates the corpus and finds a matching candidate at 100%, writing nothing outside its scratch directory', async () => {
    const before = readdirSync(dir).sort();
    const lines: string[] = [];
    const result = await compareCommand(['./bin/frob', './bin/frob-copy', '--budget', '80', '--no-sandbox'], {
      cwd: dir,
      probe: NO_SANDBOX,
      tmpDir: scratch,
      concurrency: 2,
      progress: (line) => lines.push(line),
    });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const out = result.stdout.split('\n');
    expect(out.slice(0, 5)).toEqual([
      'read "frob --help": 4 flags, 1 positional form',
      'every side runs as `frob` (argv[0] pinned) · sandbox: none (--no-sandbox)',
      'generated 80 cases (budget 80)',
      'reference re-run 2× per case: 80 stable, 0 stable after normalizers, 0 flaky-reference (left out)',
      'normalizers: none',
    ]);
    expect(result.stdout).toMatch(/^\.\/bin\/frob-copy: parity 100\.0% {2}\(mean of \d features; 80\/80 cases\)$/m);
    expect(result.stdout).toMatch(/^ {2}feature +parity$/m);
    expect(result.stdout).toMatch(/^ {2}opt\.upper +100\.0% \d+\/\d+$/m);
    expect(result.stdout).toMatch(/^ {2}opt\.help \(self-description\) +100\.0% \d+\/\d+$/m);
    expect(result.stdout).toMatch(/^done in \d+ s$/m);
    expect(lines).toEqual(['reading frob --help …', 'generating up to 80 cases …', 'running the reference 2 more times on 80 cases …', 'running the candidate …']);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('runs N candidates against one reference, scoring each, and exits 1 on a divergence', async () => {
    const { exitCode, summary } = await json(['./bin/frob', './bin/frob-copy', './bin/frob-bad', '--budget', '80']);
    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({ program_name: 'frob', sandbox: 'none (--no-sandbox)', reference: './bin/frob', untested: [] });
    expect(summary.spec).toEqual({ help: '--help', flags: 4, forms: 1, subcommands: 0, features: 4 });
    expect(summary.corpus).toMatchObject({ cases: 80, budget: 80, generator: 'v1', seed: 42, stop: 'budget', skipped: [] });
    const [good, worse] = summary.candidates;
    expect(good).toMatchObject({ command: './bin/frob-copy', parity: 1, match: 80, cases: 80, divergences: [] });
    expect(worse!.command).toBe('./bin/frob-bad');
    expect(worse!.parity).toBeLessThan(1);
    // Every divergence is a case with --upper (or -u), and its stdout differs.
    expect(worse!.divergences.length).toBe(80 - worse!.match);
    for (const d of worse!.divergences) {
      expect(d.argv.some((a) => a === '--upper' || /^-[a-z]*u/.test(a))).toBe(true);
      expect(d.fields).toContain('stdout');
    }
    const upper = worse!.per_feature.find((f) => f.feature === 'opt.upper')!;
    expect(upper.parity).toBeLessThan(1);
  });

  it('gives the same result for the same programs every time', async () => {
    const a = await json(['./bin/frob', './bin/frob-bad', '--budget', '30']);
    const b = await json(['./bin/frob', './bin/frob-bad', '--budget', '30']);
    const strip = (s: CompareSummary) => ({ ...s, duration_ms: 0 });
    expect(strip(a.summary)).toEqual(strip(b.summary));
  });

  it('leaves out and lists cases whose reference output varies between runs', async () => {
    const { exitCode, summary } = await json(['./bin/frob-flaky', './bin/frob-flaky', '--budget', '80']);
    expect(exitCode).toBe(0);
    expect(summary.baseline.flaky_reference.length).toBeGreaterThan(0);
    for (const f of summary.baseline.flaky_reference) {
      expect(f.argv.some((a) => a === '--quiet' || /^-[a-z]*q/.test(a))).toBe(true);
      expect(f.fields).toContain('stdout');
    }
    expect(summary.baseline.stable + summary.baseline.normalized + summary.baseline.flaky_reference.length).toBe(80);
    expect(summary.candidates[0]!.cases).toBe(80 - summary.baseline.flaky_reference.length);
  });

  it('re-runs the reference on a diverging case, and leaves the case out when the reference varies after all', async () => {
    const { exitCode, summary } = await json(['./bin/frob-lucky', './bin/frob-heads', '--budget', '80']);
    // The baseline saw `heads` 3 times; the scored run saw `tails`, the candidate `heads`, a re-run of the reference `heads` again.
    expect(summary.candidates[0]!.divergences).toEqual([]);
    expect(exitCode).toBe(0);
    expect(summary.baseline.flaky_reference.length).toBeGreaterThan(0);
    for (const f of summary.baseline.flaky_reference) {
      expect(f.argv.some((a) => a === '--quiet' || /^-[a-z]*q/.test(a))).toBe(true);
      expect(f.fields).toEqual(['stdout']);
    }
    expect(summary.baseline.stable + summary.baseline.normalized + summary.baseline.flaky_reference.length).toBe(80);
    expect(summary.candidates[0]).toMatchObject({ parity: 1, cases: 80 - summary.baseline.flaky_reference.length });
    expect(summary.candidates[0]!.match).toBe(summary.candidates[0]!.cases);
  });

  it('applies the normalizers the reference runs call for, and counts the cases they change', async () => {
    const { exitCode, summary } = await json(['./bin/frob-pwd', './bin/frob-pwd-copy', '--budget', '60', '--save']);
    expect(exitCode).toBe(0);
    expect(summary.baseline.normalized).toBeGreaterThan(0);
    expect(summary.baseline.flaky_reference).toEqual([]);
    expect(summary.normalizers.map((n) => n.normalizer)).toEqual(['tmp-paths on stdout']);
    expect(summary.normalizers[0]!.cases).toBe(summary.baseline.normalized);
    expect(summary.candidates[0]).toMatchObject({ parity: 1, match: 60, cases: 60, divergences: [] });
    expect((await readConfigFile(dir)).normalizers).toEqual([{ name: 'tmp-paths', options: {}, scope: ['stdout'] }]);
  });

  it('refuses to run without a sandbox unless --no-sandbox is given', async () => {
    const result = await compare(['./bin/frob', './bin/frob-copy', '--budget', '10']);
    expect(result).toMatchObject({ exitCode: 3, stdout: '' });
    expect(result.stderr).toMatch(/^port-anything compare: No local sandbox works here, so port-anything won't run generated cases\.\n {2}bwrap: bwrap is not installed\n[\s\S]*Install bubblewrap/);
  });

  it('refuses a destructive tool unless --i-know is given', async () => {
    copyFileSync(join(dir, 'bin', 'frob'), join(dir, 'bin', 'rm'));
    const refused = await compare(['./bin/rm', './bin/frob-copy', '--budget', '10', '--no-sandbox']);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr).toMatch(/Refusing to generate and run cases for "rm".*--i-know/);
    const candidate = await compare(['./bin/frob', './bin/rm', '--budget', '10', '--no-sandbox']);
    expect(candidate.exitCode).toBe(3);
    expect(candidate.stderr).toMatch(/Refusing to generate and run cases for "rm".*--i-know/);
    const allowed = await compare(['./bin/rm', './bin/frob-copy', '--budget', '10', '--no-sandbox', '--i-know']);
    expect(allowed.stderr).toBe('');
    expect(allowed.stdout).toMatch(/every side runs as `rm`/);
  });

  it('refuses programs that would need different names, and programs that are missing', async () => {
    writeFileSync(join(dir, 'bin', 'busybox'), TOOL('ref'), { mode: 0o755 });
    const names = await compare(['./bin/busybox sort', './bin/busybox cat', '--no-sandbox']);
    expect(names.exitCode).toBe(3);
    expect(names.stderr).toMatch(/runs only as "cat", but another side runs as "sort"/);
    const missing = await compare(['./bin/frob', './bin/nope', '--no-sandbox']);
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toMatch(/nope not found/);
  });

  it('--save writes a project that loads: the config with the programs and generator settings, and the CLI spec', async () => {
    const result = await compare(['./bin/frob-flaky', './bin/frob-copy', './bin/frob-bad', '--budget', '40', '--save', '--no-sandbox']);
    expect(result.stdout).toMatch(/^saved port-anything\.yaml and port-anything\/cli-spec\.yaml$/m);
    const config = await readConfigFile(dir);
    expect(config).toMatchObject({
      program_name: 'frob-flaky',
      reference: { cmd: './bin/frob-flaky' },
      candidates: [{ cmd: './bin/frob-copy' }, { cmd: './bin/frob-bad' }],
      sandbox: { mode: 'local' },
      corpus: { generator: 'v1', generator_seed: 42, budget: 40 },
    });
    expect(readFileSync(join(dir, 'port-anything.yaml'), 'utf8')).toMatch(/^# Written by port-anything compare --save\.\n/);
    expect((await readCliSpecFile(dir)).flags.map((f) => f.feature)).toEqual(['opt.quiet', 'opt.upper', 'opt.count', 'opt.help']);
    expect(readdirSync(join(dir, 'port-anything'))).toEqual(['cli-spec.yaml']);

    // Never overwrites, and says so before running anything.
    const again = await compare(['./bin/frob', './bin/frob-copy', '--save', '--no-sandbox']);
    expect(again.exitCode).toBe(3);
    expect(again.stderr).toMatch(/--save would overwrite port-anything\.yaml/);
    rmSync(join(dir, 'port-anything.yaml'));
    const spec = await compare(['./bin/frob', './bin/frob-copy', '--save', '--no-sandbox']);
    expect(spec.stderr).toMatch(new RegExp(`--save would overwrite ${CLI_SPEC_FILE}`));
  });

  it('--save with one candidate writes it under candidate', async () => {
    await compare(['./bin/frob', './bin/frob-copy', '--budget', '10', '--save', '--no-sandbox']);
    const config = await readConfigFile(dir);
    expect(config.candidate).toEqual({ cmd: './bin/frob-copy' });
    expect(config.candidates).toBeUndefined();
  });

  it('is reachable from the command line, and a usage error exits 3', async () => {
    expect(await run(['compare', './bin/frob'], { cwd: dir })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/needs a reference and at least one candidate/) });
    const ok = await run(['compare', './bin/frob', './bin/frob-copy', '--budget', '10', '--no-sandbox', '--json'], { cwd: dir });
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout).candidates[0].command).toBe('./bin/frob-copy');
  });
});

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_SPEC_FILE, GENERATED_CORPUS_FILE, cacheDir, readConfigFile } from '@port-anything/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/corpus.js';
import { parseGenerateArgs } from '../src/generate-command.js';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
// `bad` ignores --upper, so the cases using it diverge.
const TOOL = (variant: 'ref' | 'bad') => `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -u, --upper     upper-case the output\\n  -n, --count=N   stop after N lines\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=; count=
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) ;;
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
case "$count" in ''|*[!0-9]*) [ -z "$count" ] || { echo "frob: invalid count '$count'" >&2; exit 2; } ;; esac
cat "$@" | if [ -n "$upper" ]; then tr 'a-z' 'A-Z'; else cat; fi | if [ -n "$count" ]; then awk -v n="$count" 'NR <= n'; else cat; fi
`;

interface RunJson {
  cases: number;
  flaky_reference: unknown[];
  candidates: { score: { headline: number | null; raw: { match: number; scored: number } }; divergences: { case: string }[] }[];
  clusters: { cluster: number; cases: string[] }[];
}

interface CompareJson {
  corpus: { cases: number };
  baseline: { flaky_reference: unknown[] };
  candidates: { parity: number | null; match: number; cases: number; divergences: { case: string }[] }[];
}

describe('parseGenerateArgs', () => {
  it('reads --budget, --seed and --no-sandbox', () => {
    expect(parseGenerateArgs([])).toEqual({ noSandbox: false });
    expect(parseGenerateArgs(['--budget', '40', '--seed=0', '--no-sandbox'])).toEqual({ budget: 40, seed: 0, noSandbox: true });
  });

  it('refuses a budget under 1, a seed that is not a whole number, --time and unknown options', () => {
    expect(() => parseGenerateArgs(['--budget', '0'])).toThrow(/--budget must be a whole number of at least 1, got "0"/);
    expect(() => parseGenerateArgs(['--seed=-1'])).toThrow(/--seed must be a whole number of at least 0/);
    expect(() => parseGenerateArgs(['--seed', 'abc'])).toThrow(/--seed must be/);
    expect(() => parseGenerateArgs(['--time', '10m'])).toThrow(/--time is not available yet/);
    expect(() => parseGenerateArgs(['--frobnicate'])).toThrow(/frobnicate[\s\S]*Usage: port-anything generate/);
  });
});

// Each test runs a few hundred cases of a shell script, so these take seconds each.
describe('a project with a generated corpus', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-generate-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'frob'), TOOL('ref'), { mode: 0o755 });
    writeFileSync(join(dir, 'bin', 'frob-bad'), TOOL('bad'), { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (argv: string[]) => run(argv, { cwd: dir });
  const json = async <T>(argv: string[]) => {
    const result = await cli(argv);
    expect(result.stderr).toBe('');
    return { exitCode: result.exitCode, out: JSON.parse(result.stdout) as T };
  };
  const cachedIds = () => (JSON.parse(readFileSync(join(cacheDir(dir), GENERATED_CORPUS_FILE), 'utf8')) as { cases: { id: string }[] }).cases.map((c) => c.id);
  const diverging = (r: { divergences: { case: string }[] }) => r.divergences.map((d) => d.case).sort();

  it('compare --save, then run, runs the same generated cases with the same parity; a fresh clone regenerates the same cases', { timeout: 120_000 }, async () => {
    const compared = await json<CompareJson>(['compare', './bin/frob', './bin/frob-bad', '--budget', '60', '--save', '--json', '--no-sandbox']);
    expect(compared.exitCode).toBe(1);
    expect(compared.out.baseline.flaky_reference).toEqual([]);
    const [c] = compared.out.candidates;
    expect(c!.divergences.length).toBeGreaterThan(0);
    const ids = cachedIds();
    expect(ids).toHaveLength(compared.out.corpus.cases);

    const check = async () => {
      const ran = await json<RunJson>(['run', '--json', '--no-sandbox', '--holdout', '0']);
      expect(ran.exitCode).toBe(1);
      expect(ran.out.cases).toBe(compared.out.corpus.cases);
      const [r] = ran.out.candidates;
      expect(r!.score.headline).toBe(c!.parity);
      expect(r!.score.raw).toMatchObject({ match: c!.match, scored: c!.cases });
      expect(diverging(r!)).toEqual(diverging(c!));
      expect(cachedIds()).toEqual(ids);
    };
    await check();

    // A fresh clone: only the committed files, no .port-anything/.
    rmSync(join(dir, '.port-anything'), { recursive: true, force: true });
    await check();
  });

  it('compare --save uses the seed fixtures already in the directory, so a fresh clone regenerates the same cases', { timeout: 120_000 }, async () => {
    mkdirSync(join(dir, 'port-anything', 'seeds'), { recursive: true });
    writeFileSync(join(dir, 'port-anything', 'seeds', 'words.txt'), 'zebra\napple\nMango\n');
    await json<CompareJson>(['compare', './bin/frob', './bin/frob-bad', '--budget', '200', '--save', '--json', '--no-sandbox']);
    const ids = cachedIds();
    rmSync(join(dir, '.port-anything'), { recursive: true, force: true });
    expect((await json<RunJson>(['run', '--json', '--no-sandbox', '--holdout', '0'])).out.cases).toBe(ids.length);
    expect(cachedIds()).toEqual(ids);
  });

  it('generate writes the settings to the config and generates the corpus that run, baseline, minimize and report then use', { timeout: 120_000 }, async () => {
    writeFileSync(join(dir, 'port-anything.yaml'), '# my project\nversion: 1\nreference: { cmd: ./bin/frob }\ncandidate: { cmd: ./bin/frob-bad }\n');
    const noSpec = await cli(['generate', '--no-sandbox']);
    expect(noSpec.exitCode).toBe(3);
    expect(noSpec.stderr).toMatch(new RegExp(`^port-anything generate: No ${CLI_SPEC_FILE} to generate the cases from; run port-anything spec infer first`));
    expect(readFileSync(join(dir, 'port-anything.yaml'), 'utf8')).not.toMatch(/corpus/); // left as it was

    expect((await cli(['spec', 'infer', '--no-sandbox'])).exitCode).toBe(0);
    const generated = await cli(['generate', '--budget', '40', '--seed', '7', '--no-sandbox']);
    expect(generated.stderr).toBe('');
    expect(generated.exitCode).toBe(0);
    expect(generated.stdout).toMatch(/^Generated 40 cases \(budget 40, generator v2, seed 7\) as "frob", sandbox: none/);
    expect(generated.stdout).toMatch(/^set corpus\.generator, corpus\.generator_seed and corpus\.budget in port-anything\.yaml$/m);
    expect(readFileSync(join(dir, 'port-anything.yaml'), 'utf8')).toMatch(/^# my project\n/);
    expect((await readConfigFile(dir)).corpus).toEqual({ generator: 'v2', generator_seed: 7, budget: 40 });
    const ids = cachedIds();
    expect(ids).toHaveLength(40);

    // The same settings again: the same cases, and the config untouched.
    const configBefore = readFileSync(join(dir, 'port-anything.yaml'), 'utf8');
    const again = await cli(['generate', '--no-sandbox']);
    expect(again.stdout).not.toMatch(/^set corpus/m);
    expect(readFileSync(join(dir, 'port-anything.yaml'), 'utf8')).toBe(configBefore);
    expect(cachedIds()).toEqual(ids);

    const baseline = await cli(['baseline', '--no-sandbox']);
    expect(baseline.stdout).toMatch(/^Ran 40 cases 3 times each/);
    expect(baseline.stdout).toMatch(/^froze 40 cases \(40 generated, 0 recorded\); per feature: base \d+ · /m);
    expect(baseline.stdout).not.toMatch(/changed/);

    const ran = await json<RunJson>(['run', '--json', '--no-sandbox', '--holdout', '0']);
    expect(ran.out.cases).toBe(40);
    expect(ran.out.clusters.length).toBeGreaterThan(0);

    // A mutant check in a copy of the project (strength) takes the cases from the original's cache, blobs included.
    const copy = mkdtempSync(join(tmpdir(), 'pa-generate-copy-'));
    try {
      mkdirSync(join(copy, 'port-anything'));
      copyFileSync(join(dir, 'port-anything.yaml'), join(copy, 'port-anything.yaml'));
      copyFileSync(join(dir, CLI_SPEC_FILE), join(copy, CLI_SPEC_FILE));
      const copied = await loadCorpus(copy, await readConfigFile(copy), { copyOf: dir });
      expect(copied.map((c) => c.id)).toEqual(ids);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }

    // Without the cache, minimize regenerates the corpus to find the cluster's cases.
    rmSync(join(cacheDir(dir), GENERATED_CORPUS_FILE));
    const minimized = await cli(['minimize', '1', '--no-sandbox']);
    expect(minimized.stderr).toBe('');
    expect(minimized.exitCode).toBe(1);
    expect(cachedIds()).toEqual(ids);

    // report runs no program: it takes the generated cases from the cache only.
    expect((await cli(['report', '--json'])).exitCode).toBe(0);
    const config = await readConfigFile(dir);
    expect((await loadCorpus(dir, config, 'cache-only')).map((c) => c.id)).toEqual(ids);
    rmSync(join(cacheDir(dir), GENERATED_CORPUS_FILE));
    expect(await loadCorpus(dir, config, 'cache-only')).toEqual([]);
    expect((await cli(['report', '--json'])).exitCode).toBe(0);
  });

  it('baseline after a recorded case was added gives the counts it froze and says the recorded cases changed the generated ones', { timeout: 120_000 }, async () => {
    writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/frob }\ncandidate: { cmd: ./bin/frob-bad }\n');
    expect((await cli(['spec', 'infer', '--no-sandbox'])).exitCode).toBe(0);
    expect((await cli(['generate', '--budget', '150', '--no-sandbox'])).exitCode).toBe(0);
    const before = cachedIds();

    mkdirSync(join(dir, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(join(dir, 'port-anything', 'recorded', 'mine.jsonl'), `${JSON.stringify({ argv: ['-u'], stdin: 'Hello, World\n', features: ['mine'], origin: 'recorded' })}\n`);
    const baseline = await cli(['baseline', '--no-sandbox']);
    expect(baseline.stderr).toBe('');
    expect(baseline.exitCode).toBe(0);
    expect(cachedIds()).not.toEqual(before);
    const froze = /^froze (\d+) cases \((\d+) generated, 1 recorded\); per feature: (.*)$/m.exec(baseline.stdout);
    expect(froze).not.toBeNull();
    expect(Number(froze![1])).toBe(Number(froze![2]) + 1);
    const perFeature = new Map(froze![3]!.split(' · ').map((f) => f.split(' ') as [string, string]));
    // The recorded case and the mutants generator v2 made of it.
    expect(Number(perFeature.get('mine'))).toBeGreaterThan(1);
    const changed = /^the recorded cases changed the generated ones \(generator v2 mutates them\); generated cases per feature, before → now: (.*)$/m.exec(baseline.stdout);
    expect(changed?.[1]).toMatch(/(^|, )mine 0 → \d+(, |$)/);

    // Nothing changed since: nothing to say.
    expect((await cli(['baseline', '--no-sandbox'])).stdout).not.toMatch(/changed/);

    // Another seed is not the recorded cases' doing.
    const config = readFileSync(join(dir, 'port-anything.yaml'), 'utf8');
    writeFileSync(join(dir, 'port-anything.yaml'), config.replace(/generator_seed: \d+/, 'generator_seed: 5'));
    const reseeded = await cli(['baseline', '--no-sandbox']);
    expect(reseeded.stdout).toMatch(
      /^the generated cases changed since they were last generated \(the CLI spec, seeds, settings or reference command changed\); (generated cases per feature, before → now: .+|the same number per feature)$/m,
    );
    expect(reseeded.stdout).not.toMatch(/recorded cases changed/);
  });

  it('run without the CLI spec says how to get one, and a project without generator settings runs only its committed cases', async () => {
    writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/frob }\ncandidate: { cmd: ./bin/frob-bad }\ncorpus: { generator: v1, generator_seed: 1 }\n');
    const missing = await cli(['run', '--no-sandbox']);
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toMatch(/No port-anything\/cli-spec\.yaml to generate the cases from; run port-anything spec infer first/);

    writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/frob }\ncandidate: { cmd: ./bin/frob-bad }\n');
    const none = await cli(['run', '--no-sandbox']);
    expect(none.exitCode).toBe(3);
    expect(none.stderr).toMatch(/No cases to run: add some to port-anything\/recorded\/\*\.jsonl, or generate them with port-anything generate\./);
  });
});

describe('a project whose input is code', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-generate-code-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (argv: string[]) => run(argv, { cwd: dir });

  it('generate mutates the recorded awk programs, which the CLI spec alone cannot write', { timeout: 120_000 }, async () => {
    mkdirSync(join(dir, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(
      join(dir, CLI_SPEC_FILE),
      [
        'version: 1',
        'program: awk',
        'flags:',
        '  - { names: [ -F ], feature: opt.F, arity: 1, values: [ { name: fs, type: string } ] }',
        'forms:',
        "  - usage: awk [-F fs] 'prog' [file ...]",
        '    flags: [ -F ]',
        '    args: [ { name: prog, type: string, arity: "1" } ]',
        '',
      ].join('\n'),
    );
    const input = 'a b c\nd e f\n1 2 3\n';
    const cases = [
      { argv: ['{print $2}'], features: ['fields'] },
      { argv: ['{print NF, $NF}'], features: ['fields'] },
      { argv: ['{n += $3} END {print n + 0}'], features: ['arith'] },
      { argv: ['NR > 1 {print NR * 2}'], features: ['arith'] },
      { argv: ['/e/ {print toupper($0)}'], features: ['regex'] },
      { argv: ['-F', 'e', '{print $1 "|" $2}'], features: ['opt.F', 'regex'] },
    ];
    writeFileSync(join(dir, 'port-anything', 'recorded', 'awk.jsonl'), cases.map((c) => JSON.stringify({ ...c, stdin: input, origin: 'recorded' })).join('\n') + '\n');
    writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: awk }\ncandidate: { cmd: awk }\ncorpus: { min_cases_per_feature: 5 }\n');

    const generated = await cli(['generate', '--budget', '60', '--seed', '3', '--no-sandbox']);
    expect(generated.stderr).toBe('');
    expect(generated.exitCode).toBe(0);
    const recordedPrograms = new Set(cases.map((c) => c.argv.join(' ')));
    const corpus = (await loadCorpus(dir, await readConfigFile(dir), 'cache-only')).filter((c) => c.origin === 'generated');
    // The recorded features exist only in the recorded cases, so these cases are their mutants.
    const mutants = corpus.filter((c) => c.features.some((f) => ['fields', 'arith', 'regex'].includes(f)));
    expect(mutants.length).toBeGreaterThanOrEqual(10);
    expect(mutants.filter((c) => !recordedPrograms.has(c.argv.join(' '))).length).toBeGreaterThan(0);
  });
});

// Reads stdin only: any argument but -a and -b gets the usage text, the way xxd answers a spec
// that gives it one positional too many.
const STDIN_ONLY = `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: blip [-a] [-b] FILE\\n\\n  -a   number the lines\\n  -b   upper-case the output\\n'
  exit 0
fi
a=; b=
for arg; do
  case "$arg" in
    -a) a=1 ;;
    -b) b=1 ;;
    *) printf 'usage: blip [-a] [-b] < infile\\n' >&2; exit 1 ;;
  esac
done
if [ -n "$a" ]; then awk '{ print NR ": " $0 }'; else cat; fi | if [ -n "$b" ]; then tr 'a-z' 'A-Z'; else cat; fi
`;

describe('a spec the program rejects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-generate-weak-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'blip'), STDIN_ONLY, { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (argv: string[]) => run(argv, { cwd: dir });
  const diagnosis = (command: string) =>
    new RegExp(`^port-anything ${command}: warning: (\\d+) features? got no case \\(([^)]*)\\): (\\d+)% of the reference's answers were its usage text; `, 'm');

  it('generate says which features got no case and that most answers were the usage text', { timeout: 120_000 }, async () => {
    // Like xxd's -h, -b is in the help but not in the program.
    writeFileSync(join(dir, 'bin', 'blip'), STDIN_ONLY.replace('    -b) b=1 ;;\n', ''), { mode: 0o755 });
    mkdirSync(join(dir, 'port-anything'));
    // The help's FILE is a required positional, which blip refuses.
    writeFileSync(
      join(dir, CLI_SPEC_FILE),
      [
        'version: 1',
        'program: blip',
        'flags:',
        '  - { names: [ -a ], feature: opt.a, arity: 0 }',
        '  - { names: [ -b ], feature: opt.b, arity: 0 }',
        'forms:',
        '  - usage: blip [-a] [-b] FILE',
        '    flags: [ -a, -b ]',
        '    args: [ { name: FILE, type: path, arity: "1" } ]',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/blip }\ncandidate: { cmd: ./bin/blip }\n');
    const generated = await cli(['generate', '--budget', '200', '--no-sandbox']);
    expect(generated.exitCode).toBe(0);
    const [, count, features, share] = diagnosis('generate').exec(generated.stderr) ?? [];
    expect(features?.split(', ')).toEqual(expect.arrayContaining(['opt.a', 'opt.b']));
    expect(Number(count)).toBe(features!.split(', ').length);
    expect(Number(share)).toBeGreaterThan(50);
    expect(generated.stderr).toMatch(/; check the forms and flags in port-anything\/cli-spec\.yaml\n$/);
    // The list stays on stdout too, where it always was.
    expect(generated.stdout).toMatch(/^untested \(no generated case\): .*opt\.a/m);
  });

  it('compare says the same of the spec it read from the help', { timeout: 120_000 }, async () => {
    const compared = await cli(['compare', './bin/blip', './bin/blip', '--budget', '200', '--no-sandbox']);
    expect(compared.exitCode).toBe(0);
    expect(compared.stderr).toMatch(diagnosis('compare'));
    expect(compared.stderr).toMatch(/; check the CLI spec read from the help \(--save writes it to port-anything\/cli-spec\.yaml\)\n$/);
    const json = await cli(['compare', './bin/blip', './bin/blip', '--budget', '200', '--no-sandbox', '--json']);
    const { diagnosis: line } = JSON.parse(json.stdout) as { diagnosis: string | null };
    expect(line).toMatch(/^\d+ features? got no case \(.*opt\.a.*\): \d+% of the reference's answers were its usage text$/);
  });

  it('compare stays quiet about a spec the program accepts', { timeout: 120_000 }, async () => {
    writeFileSync(join(dir, 'bin', 'blip'), STDIN_ONLY.replace(' FILE\\n', '\\n'), { mode: 0o755 });
    const compared = await cli(['compare', './bin/blip', './bin/blip', '--budget', '100', '--no-sandbox', '--json']);
    expect(compared.stderr).toBe('');
    expect((JSON.parse(compared.stdout) as { diagnosis: string | null }).diagnosis).toBeNull();
  });
});

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
      const ran = await json<RunJson>(['run', '--json', '--no-sandbox']);
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
    expect((await json<RunJson>(['run', '--json', '--no-sandbox'])).out.cases).toBe(ids.length);
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
    expect(generated.stdout).toMatch(/^Generated 40 cases \(budget 40, generator v1, seed 7\) as "frob", sandbox: none/);
    expect(generated.stdout).toMatch(/^set corpus\.generator, corpus\.generator_seed and corpus\.budget in port-anything\.yaml$/m);
    expect(readFileSync(join(dir, 'port-anything.yaml'), 'utf8')).toMatch(/^# my project\n/);
    expect((await readConfigFile(dir)).corpus).toEqual({ generator: 'v1', generator_seed: 7, budget: 40 });
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

    const ran = await json<RunJson>(['run', '--json', '--no-sandbox']);
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

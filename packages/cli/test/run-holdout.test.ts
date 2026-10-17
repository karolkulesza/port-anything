import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, cacheDir, loadCommittedCases, runsDir } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORT_JSON_FILE } from '../src/report-command.js';
import { HOLDOUT_FAILURES_FILE } from '../src/run-command.js';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const FROB = `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -u, --upper     upper-case the output\\n  -n, --count=N   stop after N lines\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=; count=
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) ;;
    -u|--upper) upper=1 ;;
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

/**
 * A wrapper around the reference that first hashes everything the case gives it (argv, stdin,
 * the files it names). `record` appends the hash to a key file and answers like the reference;
 * `lookup` answers like the reference only for a hash in that file, the way a table of the
 * corpus's expected outputs would, and makes something up for any other case.
 */
const WRAPPER = (mode: 'record' | 'lookup', reference: string, keys: string) => `#!/bin/sh
in=$(mktemp)
cat > "$in"
key=$({ printf '%s\\n' "$@"; cat "$in"; for a in "$@"; do [ -f "$a" ] && cat "$a"; done; } | cksum)
${
  mode === 'record'
    ? `echo "$key" >> '${keys}'\n'${reference}' "$@" < "$in"; status=$?`
    : `if grep -qxF "$key" '${keys}'; then '${reference}' "$@" < "$in"; status=$?; else echo 'made up'; status=0; fi`
}
rm -f "$in"
exit $status
`;

interface Holdout {
  match: number;
  diverge: number;
  parity: number | null;
  ci95: [number, number] | null;
  features: number;
  gap: { corpus: number; holdout: number; gap: number; p_value: number; features: unknown[]; clusters: { corpus: number; holdout: number } } | null;
  significant: boolean;
  diverging: string[];
}

interface RunJson {
  run_id: string;
  cases: number;
  holdout: { ran: true; requested: number; cases: number; in_corpus: number; flaky_reference: number; alpha: number; saved: number } | { ran: false; reason: string };
  candidates: { command: string; diverge: number; score: { headline: number | null }; holdout?: Holdout }[];
}

// Each run generates and runs a few hundred cases of a shell script, so these take seconds.
describe('run with a fresh holdout', () => {
  let dir: string;
  const cli = (argv: string[]) => run(argv, { cwd: dir });
  const json = async (argv: string[]) => {
    const result = await cli([...argv, '--json', '--no-sandbox']);
    expect(result.stderr).toBe('');
    return { exitCode: result.exitCode, out: JSON.parse(result.stdout) as RunJson };
  };

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-holdout-')));
    mkdirSync(join(dir, 'bin'));
    const keys = join(dir, 'corpus-keys');
    const reference = join(dir, 'bin', 'frob');
    writeFileSync(reference, FROB, { mode: 0o755 });
    writeFileSync(join(dir, 'bin', 'frob-copy'), FROB, { mode: 0o755 });
    writeFileSync(join(dir, 'bin', 'frob-record'), WRAPPER('record', reference, keys), { mode: 0o755 });
    writeFileSync(join(dir, 'bin', 'frob-lookup'), WRAPPER('lookup', reference, keys), { mode: 0o755 });
    writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/frob }\ncandidate: { cmd: ./bin/frob-copy }\ncorpus:\n  min_cases_per_feature: 5\n');
    expect((await cli(['spec', 'infer', '--no-sandbox'])).exitCode).toBe(0);
    expect((await cli(['generate', '--budget', '80', '--seed', '7', '--no-sandbox'])).exitCode).toBe(0);
    // The lookup table: every corpus case's input, recorded by running the corpus without a holdout.
    const recorded = await json(['run', '--candidate', './bin/frob-record', '--holdout', '0']);
    expect(recorded.exitCode).toBe(0);
    expect(recorded.out.holdout).toEqual({ ran: false, reason: 'turned off with --holdout 0' });
    expect(readFileSync(keys, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(recorded.out.cases);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('flags a lookup-table candidate, perfect on the corpus, and not a correct one (done when)', { timeout: 120_000 }, async () => {
    const { exitCode, out } = await json(['run', '--candidate', './bin/frob-lookup', '--candidate', './bin/frob-copy', '--holdout', '100']);
    expect(out.holdout).toMatchObject({ ran: true, requested: 100, alpha: 0.01, flaky_reference: 0 });
    if (!out.holdout.ran) throw new Error('no holdout');
    expect(out.holdout.cases).toBeGreaterThan(40);
    expect(out.holdout.cases + out.holdout.in_corpus).toBeLessThanOrEqual(100);
    const [lookup, honest] = out.candidates;

    expect(lookup!.diverge).toBe(0);
    expect(lookup!.score.headline).toBe(1);
    expect(lookup!.holdout).toMatchObject({ significant: true, gap: { corpus: 1 } });
    expect(lookup!.holdout!.parity).toBeLessThan(0.5);
    expect(lookup!.holdout!.gap!.p_value).toBeLessThan(0.01);
    expect(lookup!.holdout!.gap!.clusters.holdout).toBeGreaterThan(5);
    expect(lookup!.holdout!.diverging.length).toBeGreaterThan(0);

    expect(honest!.holdout).toMatchObject({ diverge: 0, parity: 1, gap: { corpus: 1, holdout: 1, gap: 0, p_value: 1 }, significant: false, diverging: [] });
    expect(exitCode).toBe(1); // the corpus alone passes; the gap fails the run

    // The seed is in no output and no file.
    expect(JSON.stringify(out.holdout)).not.toMatch(/seed/);
    expect(readFileSync(join(runsDir(dir), out.run_id, 'run.json'), 'utf8')).not.toMatch(/"seed"/);

    // The cases it diverged on are saved in the format of the committed case files, ready to be kept.
    expect(out.holdout.saved).toBe(lookup!.holdout!.diverging.length);
    const copy = mkdtempSync(join(tmpdir(), 'pa-holdout-copy-'));
    try {
      mkdirSync(join(copy, 'port-anything', 'recorded'), { recursive: true });
      copyFileSync(join(runsDir(dir), out.run_id, HOLDOUT_FAILURES_FILE), join(copy, 'port-anything', 'recorded', 'burned.jsonl'));
      const saved = await loadCommittedCases(copy, new BlobStore(cacheDir(copy)));
      expect(saved.map((c) => c.id).sort()).toEqual([...lookup!.holdout!.diverging].sort());
      expect(saved.every((c) => c.origin === 'generated')).toBe(true);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('draws new cases on every run', { timeout: 120_000 }, async () => {
    const ids = async () => {
      const { out } = await json(['run', '--candidate', './bin/frob-lookup', '--holdout', '40']);
      return new Set(out.candidates[0]!.holdout!.diverging);
    };
    const [a, b] = [await ids(), await ids()];
    expect(a.size).toBeGreaterThan(0);
    expect([...b].filter((id) => a.has(id)).length).toBeLessThan(b.size / 2);
  });

  it('prints the holdout parity with its interval and the gap, and fails only on a significant gap', { timeout: 120_000 }, async () => {
    const honest = await cli(['run', '--holdout', '40', '--no-sandbox']);
    expect(honest.exitCode).toBe(0);
    expect(honest.stdout).toMatch(/^ {2}fresh holdout 100\.0% \(95% CI \d+\.\d%–100\.0%\), mean of \d+ features\n {2}gap to the corpus 0\.0 points on byte-mutated cases of \d+ features \(corpus 100\.0%, holdout 100\.0%\): not significant \(p = 1\.0\)$/m);
    expect(honest.stdout).toMatch(/^fresh holdout: \d+ new cases from a seed that is not stored/m);
    expect(honest.stdout).not.toMatch(/saved for reproduction/);

    const lookup = await cli(['run', '--candidate', './bin/frob-lookup', '--holdout', '100', '--no-sandbox']);
    expect(lookup.exitCode).toBe(1);
    expect(lookup.stdout).toMatch(/^ {2}gap to the corpus \d+\.\d points on byte-mutated cases of \d+ features \(corpus 100\.0%, holdout \d+\.\d%\): SIGNIFICANT \(p [<=] [\d.e-]+\)$/m);
    expect(lookup.stdout).toMatch(/beyond chance: it may be fitted to the corpus/);
    const runId = /^run (\S+)/m.exec(lookup.stdout)![1]!;
    expect(lookup.stdout).toContain(`fresh-holdout cases that diverge, saved for reproduction: .port-anything/runs/${runId}/${HOLDOUT_FAILURES_FILE}\n`);

    // The report of that run carries the holdout and the gap, for CI.
    expect((await cli(['report', '--json'])).exitCode).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, REPORT_JSON_FILE), 'utf8')) as { run_id: string; holdout: { ran: boolean }; candidates: { holdout: { significant: boolean; gap: { corpus: number } | null } | null }[] };
    expect(report.run_id).toBe(runId);
    expect(report.holdout).toMatchObject({ ran: true, alpha: 0.01 });
    expect(report.candidates[0]!.holdout).toMatchObject({ significant: true, gap: { corpus: 1 } });
  });

  it('leaves out a holdout case as flaky-reference when the reference answers differently on a second run', { timeout: 120_000 }, async () => {
    const config = readFileSync(join(dir, 'port-anything.yaml'), 'utf8');
    // The reference adds its process ID, so every case diverges and every re-check of it varies.
    writeFileSync(join(dir, 'bin', 'frob-noisy'), `#!/bin/sh\n'${join(dir, 'bin', 'frob')}' "$@"; status=$?\necho "$$"\nexit $status\n`, { mode: 0o755 });
    try {
      writeFileSync(join(dir, 'port-anything.yaml'), config.replace('./bin/frob }', './bin/frob-noisy }'));
      const { out } = await json(['run', '--holdout', '40']);
      if (!out.holdout.ran) throw new Error('the holdout did not run');
      expect(out.holdout.cases).toBeGreaterThan(0);
      expect(out.holdout.flaky_reference).toBe(out.holdout.cases);
      expect(out.candidates[0]!.holdout).toMatchObject({ match: 0, diverge: 0, diverging: [], significant: false });
    } finally {
      writeFileSync(join(dir, 'port-anything.yaml'), config);
    }
  });

  it('has no holdout with holdout.fresh_cases: 0 (unless --holdout asks for one), nor in a smoke run', { timeout: 120_000 }, async () => {
    const config = readFileSync(join(dir, 'port-anything.yaml'), 'utf8');
    try {
      writeFileSync(join(dir, 'port-anything.yaml'), `${config}holdout:\n  fresh_cases: 0\n`);
      const off = await json(['run']);
      expect(off.out.holdout).toEqual({ ran: false, reason: 'turned off (holdout.fresh_cases: 0)' });
      expect(off.out.candidates[0]!.holdout).toBeUndefined();
      expect((await json(['run', '--holdout', '20'])).out.holdout).toMatchObject({ ran: true, requested: 20 }); // --holdout wins
    } finally {
      writeFileSync(join(dir, 'port-anything.yaml'), config);
    }
    // Only recorded cases: the holdout runs, but there are no generated byte mutants to test the gap on.
    try {
      writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/frob }\ncandidate: { cmd: ./bin/frob-lookup }\n');
      mkdirSync(join(dir, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(join(dir, 'port-anything', 'recorded', 'mine.jsonl'), '{"argv":["-u"],"stdin":"hi\\n","origin":"recorded"}\n');
      const recorded = await cli(['run', '--holdout', '30', '--no-sandbox']);
      expect(recorded.stdout).toMatch(/^fresh holdout: \d+ new cases/m);
      expect(recorded.stdout).toContain('  gap to the corpus not tested: the corpus has no generated byte-mutated cases to compare with (port-anything generate makes them)\n');
    } finally {
      writeFileSync(join(dir, 'port-anything.yaml'), config);
      rmSync(join(dir, 'port-anything', 'recorded'), { recursive: true, force: true });
    }
    const smoke = await cli(['run', '--smoke', '--no-sandbox']);
    expect(smoke.stdout).not.toMatch(/fresh holdout/);
  });
});

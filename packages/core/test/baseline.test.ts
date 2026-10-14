import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baselineCases, type BaselineOptions } from '../src/baseline.js';
import { BlobStore } from '../src/blob-store.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { NormalizersSchema, normalizePair } from '../src/normalize.js';
import { parseProgramCommand, resolveProgram, type ResolvedProgram } from '../src/program.js';

// A reference whose output varies between runs. Each case keeps a run counter in its own file
// under $PA_TEST_COUNTERS (allow-listed below), so every run of a case differs from the last one
// in a known way: timestamps, the working directory, the PID, and the order of lines.
const NONDETERMINISTIC = `#!/bin/sh
counter="$PA_TEST_COUNTERS/$1"
n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$counter"
case "$1" in
  stable) echo same; echo note >&2 ;;
  log) echo "[2026-10-1\${n}T08:0\${n}:00Z] worker pid $$ started in $(pwd)" >&2; echo done ;;
  list) case $((n % 3)) in 0) printf 'apple\\nfig\\npear\\n' ;; 1) printf 'fig\\npear\\napple\\n' ;; *) printf 'pear\\napple\\nfig\\n' ;; esac ;;
  report) echo "generated 2026-10-14 10:00:0\${n}" > report.txt; echo ok ;;
  random) echo "token \${n}" ;;
  exit) exit $((n % 2)) ;;
esac
`;

describe('baselineCases', () => {
  let root: string;
  let store: BlobStore;
  let reference: ResolvedProgram;
  let cases: Record<string, CanonicalCase>;
  let scratch = 0;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-baseline-')));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'tool'), NONDETERMINISTIC, { mode: 0o755 });
    store = new BlobStore(join(root, 'cache'));
    reference = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool')));
    cases = Object.fromEntries(
      ['stable', 'log', 'list', 'report', 'random', 'exit'].map((name) => [name, canonicalCase({ argv: [name], features: [`cmd.${name}`], origin: 'generated' })]),
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const options = (extra: Partial<BaselineOptions> = {}): BaselineOptions => {
    const counters = join(root, `counters-${scratch}`);
    mkdirSync(counters);
    return {
      reference,
      cases: Object.values(cases),
      store,
      sandbox: { kind: 'none' },
      workDir: join(root, `work-${scratch++}`),
      envAllowlist: ['PA_TEST_COUNTERS'],
      hostEnv: { ...process.env, PA_TEST_COUNTERS: counters },
      ...extra,
    };
  };
  const byCase = (result: Awaited<ReturnType<typeof baselineCases>>) => Object.fromEntries(result.cases.map((c) => [Object.entries(cases).find(([, k]) => k.id === c.caseId)![0], c]));

  it('proposes the normalizers for timestamps, temp paths, PIDs and unordered output, scoped to where they were needed', async () => {
    const result = await baselineCases(options());
    expect(result.repeats).toBe(3);
    expect(result.programName).toBe('tool');
    expect(result.proposals).toEqual([
      { spec: { name: 'tmp-paths', options: {}, scope: ['stderr'] }, cases: 1 },
      { spec: { name: 'iso-timestamps', options: {}, scope: ['stderr', 'files:report.txt'] }, cases: 2 },
      { spec: { name: 'pids', options: {}, scope: ['stderr'] }, cases: 1 },
      { spec: { name: 'sort-lines', options: {}, scope: ['stdout'], features: ['cmd.list'] }, cases: 1 },
    ]);
    expect(result.withheld).toEqual([]);

    const c = byCase(result);
    expect(result.cases.map((r) => r.caseId)).toEqual(Object.values(cases).map((k) => k.id));
    expect(c.stable).toMatchObject({ status: 'stable', varied: [], fixes: [], unstable: [] });
    expect(c.log).toMatchObject({ status: 'normalized', varied: ['stderr'], fixes: [{ field: 'stderr', normalizers: ['tmp-paths', 'iso-timestamps', 'pids'] }], unstable: [] });
    expect(c.list).toMatchObject({ status: 'normalized', varied: ['stdout'], fixes: [{ field: 'stdout', normalizers: ['sort-lines'] }] });
    expect(c.report).toMatchObject({ status: 'normalized', varied: ['file:report.txt'], fixes: [{ field: 'file:report.txt', normalizers: ['iso-timestamps'] }] });
    // Output no normalizer explains, and a varying exit code, make the reference flaky.
    expect(c.random).toMatchObject({ status: 'flaky-reference', varied: ['stdout'], fixes: [], unstable: ['stdout'] });
    expect(c.exit).toMatchObject({ status: 'flaky-reference', varied: ['exit'], unstable: ['exit'] });
    for (const r of result.cases) expect(r.observations).toHaveLength(3);
  });

  it('runs each repeat in its own directory', async () => {
    const result = await baselineCases(options({ repeats: 2 }));
    const log = byCase(result).log!;
    expect(log.observations).toHaveLength(2);
    const dirs = await Promise.all(log.observations.map(async (o) => /started in (\S+)/.exec((await store.get(o.stderr)).toString())![1]));
    expect(new Set(dirs).size).toBe(2);
  });

  it('proposes nothing more once the proposals are configured, and nothing already configured everywhere', async () => {
    const first = await baselineCases(options());
    const again = await baselineCases(options({ normalizers: first.proposals.map((p) => p.spec) }));
    expect(again.proposals).toEqual([]);
    expect(byCase(again).log).toMatchObject({ status: 'stable', varied: [] });
    expect(byCase(again).random!.status).toBe('flaky-reference');

    const partly = await baselineCases(options({ normalizers: NormalizersSchema.parse(['tmp-paths', 'iso-timestamps']) }));
    expect(partly.proposals.map((p) => p.spec.name)).toEqual(['pids', 'sort-lines']);
    expect(byCase(partly).report!.status).toBe('stable');
    expect(byCase(partly).log).toMatchObject({ status: 'normalized', fixes: [{ field: 'stderr', normalizers: ['pids'] }] });
  });

  it('confines sort-lines to the features that need it, so other cases keep their line order checked', async () => {
    const result = await baselineCases(options());
    const sortLines = result.proposals.find((p) => p.spec.name === 'sort-lines')!.spec;
    const unordered = await store.put('b\na\n');
    const observation = { ...result.cases[0]!.observations[0]!, stdout: unordered };
    const context = { tempRoots: [], programNames: [] };
    const normalize = (features: string[]) =>
      normalizePair({ normalizers: [sortLines], features, reference: { observation, context }, candidate: { observation, context }, store: store });
    expect((await normalize(['cmd.other'])).changedBy).toEqual([]);
    expect((await normalize(['cmd.list'])).changedBy).toEqual([0]);
  });

  it('withholds sort-lines when a case that needs it has no features, leaving it flaky-reference', async () => {
    const featureless = canonicalCase({ argv: ['list', 'again'], origin: 'generated' });
    // One at a time: both cases are `list` and share its run counter.
    const result = await baselineCases(options({ cases: [cases.list!, featureless], concurrency: 1 }));
    expect(result.proposals).toEqual([]);
    expect(result.withheld).toEqual([{ name: 'sort-lines', cases: 2 }]);
    expect(result.cases.map((c) => c.status)).toEqual(['flaky-reference', 'flaky-reference']);
    expect(result.cases[1]).toMatchObject({ fixes: [{ field: 'stdout', normalizers: ['sort-lines'] }], unstable: ['stdout'] });
  });

  it('needs at least 2 runs', async () => {
    await expect(baselineCases(options({ repeats: 1 }))).rejects.toThrow(/at least 2/);
  });
});

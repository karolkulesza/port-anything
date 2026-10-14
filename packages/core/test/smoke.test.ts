import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blob-store.js';
import { ConfigError } from '../src/config.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { inlineCase, saveRepro, saveRun } from '../src/runs.js';
import { SMOKE_CASES_PER_FEATURE, SMOKE_PASSING_CASES, openClusterCases, smokeSubset } from '../src/smoke.js';

/** Case n, with the given features. */
const make = (n: number, features: string[] = [], origin: 'recorded' | 'generated' = 'recorded') =>
  canonicalCase({ argv: [`case-${n}`], features, origin });
const ids = (cases: readonly CanonicalCase[]) => cases.map((c) => c.id);
const byId = (cases: readonly CanonicalCase[]) => [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

describe('smokeSubset', () => {
  it('takes the cases of the open clusters, then N cases per feature, then a sample of passing cases', () => {
    const corpus = [
      ...Array.from({ length: 12 }, (_, i) => make(i, ['opt.a'])),
      ...Array.from({ length: 12 }, (_, i) => make(100 + i, ['opt.b'])),
      ...Array.from({ length: 30 }, (_, i) => make(200 + i)),
    ];
    const repro = canonicalCase({ argv: ['minimized'], features: ['opt.a'], origin: 'recorded' });
    const subset = smokeSubset({ corpus, clusterCases: [repro], diverged: new Set(), perFeature: 3, passing: 4 });

    expect(subset.cases[0]).toBe(repro);
    expect(subset).toMatchObject({ clusters: 1, perFeature: 9, passing: 4 });
    expect(subset.cases).toHaveLength(1 + 9 + 4);
    // Per feature (`base` for untagged cases): the first N by case ID, a stable sample.
    for (const from of [corpus.slice(0, 12), corpus.slice(12, 24), corpus.slice(24)]) {
      for (const c of byId(from).slice(0, 3)) expect(subset.cases).toContain(c);
    }
    // The rest are kept in corpus order.
    const rest = subset.cases.slice(1);
    expect(ids(rest)).toEqual(ids(corpus.filter((c) => rest.includes(c))));
    // The same input gives the same subset.
    expect(ids(smokeSubset({ corpus, clusterCases: [repro], diverged: new Set(), perFeature: 3, passing: 4 }).cases)).toEqual(ids(subset.cases));
  });

  it('draws the passing sample only from cases that did not diverge in the latest run, and counts each case once', () => {
    const corpus = Array.from({ length: 10 }, (_, i) => make(i));
    const sorted = byId(corpus);
    const diverged = new Set(ids(sorted.slice(0, 6)));
    // A cluster's case from the corpus, also first by ID: picked once, as the cluster's.
    const subset = smokeSubset({ corpus, clusterCases: [sorted[0]!, sorted[0]!], diverged, perFeature: 2, passing: 3 });
    expect(subset).toMatchObject({ clusters: 1, perFeature: 1, passing: 3 });
    expect(ids(subset.cases)).toEqual([sorted[0]!.id, ...ids(corpus.filter((c) => [sorted[1], ...sorted.slice(6, 9)].includes(c)))]);
  });

  it('is the whole corpus when the corpus is small, and the cluster cases alone when N and the sample are 0', () => {
    const corpus = [make(1, ['opt.a']), make(2, ['opt.a', 'opt.b']), make(3)];
    expect(ids(smokeSubset({ corpus, clusterCases: [], diverged: new Set() }).cases)).toEqual(ids(corpus));
    expect(smokeSubset({ corpus, clusterCases: [corpus[2]!], diverged: new Set(), perFeature: 0, passing: 0 })).toEqual({ cases: [corpus[2]], clusters: 1, perFeature: 0, passing: 0 });
  });

  it('has defaults that keep a large corpus small', () => {
    const corpus = Array.from({ length: 2000 }, (_, i) => make(i, [`opt.${i % 20}`]));
    const subset = smokeSubset({ corpus, clusterCases: [], diverged: new Set() });
    expect(subset).toMatchObject({ clusters: 0, perFeature: 20 * SMOKE_CASES_PER_FEATURE, passing: SMOKE_PASSING_CASES });
  });
});

describe('openClusterCases', () => {
  let project: string;
  let store: BlobStore;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-smoke-')));
    store = new BlobStore(join(project, 'cache'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const cluster = (n: number, cases: string[]) => ({
    cluster: n,
    candidate: 1,
    signature: { fields: ['stdout' as const], shapes: [{ field: 'stdout' as const, shape: 'number-value' as const }] },
    features: [],
    size: cases.length,
    weight: 1,
    cases,
  });

  it("gives each cluster's saved repro, or else its smallest case still in the corpus, and skips clusters the corpus no longer has", async () => {
    const big = canonicalCase({ argv: ['-l'], stdin: await store.put('one\ntwo\nthree'), features: ['opt.l'], origin: 'generated' });
    const small = canonicalCase({ argv: ['-l'], stdin: await store.put('one'), features: ['opt.l'], origin: 'recorded' });
    const other = canonicalCase({ argv: ['-x'], origin: 'recorded' });
    const gone = `sha256:${'f'.repeat(64)}`;
    const run = await saveRun(project, { subset: null, candidate_commands: ['./bad'], clusters: [cluster(1, [big.id, small.id]), cluster(2, [big.id, small.id]), cluster(3, [other.id]), cluster(4, [gone])] });
    // Cluster 2's repro, minimized from `big`, takes its features and origin.
    // Its content is only inline, as minimize saved it from another cache.
    const scratch = new BlobStore(join(project, 'scratch'));
    const withFixture = canonicalCase({ argv: [], stdin: await scratch.put('t'), fixtures: { 'a.txt': await scratch.put(Buffer.from([0xff])) }, origin: 'recorded' });
    await saveRepro(project, { run_id: run.run_id, cluster: 2, source: big.id, reproduced: true, runs: 9, max_runs: 200, exhausted: false, case: await inlineCase(withFixture, scratch) });

    const cases = await openClusterCases(project, run, [big, small, other], store);
    expect(cases).toEqual([small, { ...withFixture, features: ['opt.l'], origin: 'generated' }, other]);
    // Its content is put in the store it was given.
    expect((await store.get(cases[1]!.fixtures['a.txt']!)).equals(Buffer.from([0xff]))).toBe(true);
  });

  it('takes a repro whose source left the corpus as a generated case without features, and refuses a damaged one', async () => {
    const source = canonicalCase({ argv: ['-l', 'x'], origin: 'recorded', features: ['opt.l'] });
    const run = await saveRun(project, { subset: null, candidate_commands: ['./bad'], clusters: [cluster(1, [source.id])] });
    const minimized = canonicalCase({ argv: ['-l'], origin: 'recorded' });
    const save = (id: string) =>
      saveRepro(project, { run_id: run.run_id, cluster: 1, source: source.id, reproduced: true, runs: 3, max_runs: 200, exhausted: false, case: { id, argv: ['-l'], stdin: null, env: {}, fixtures: {} } });
    await save(minimized.id);
    expect(await openClusterCases(project, run, [], store)).toEqual([{ ...minimized, features: [], origin: 'generated' }]);
    await save(source.id);
    await expect(openClusterCases(project, run, [source], store)).rejects.toThrow(ConfigError);
    await expect(openClusterCases(project, run, [source], store)).rejects.toThrow(/repro of cluster .*\/1 is damaged/);
  });
});

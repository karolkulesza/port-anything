import { describe, expect, it } from 'vitest';
import { blobRef } from '../src/blob-store.js';
import { parseCliSpec, type CliSpec } from '../src/cli-spec.js';
import { parseConfig } from '../src/config.js';
import { generateCorpus, type ObserveReference } from '../src/corpus-generator.js';
import {
  DEFAULT_FRESH_CASES,
  DEFAULT_GAP_ALPHA,
  MIN_GAP_CASES,
  freshHoldoutSeed,
  gapCluster,
  generateFreshHoldout,
  holdoutGap,
  holdoutParity,
  holdoutSettings,
  normalCdf,
  studentTCdf,
  type GapCase,
} from '../src/holdout.js';
import { canonicalObservation, type CanonicalCase } from '../src/model.js';
import { createRng, type Rng } from '../src/rng.js';

type Counts = Record<string, { n: number; match: number }>;

let next = 0;
/** `n` cases of each feature, `match` of them matching, each its own cluster unless `clusterSize` groups them. */
function side(counts: Counts, clusterSize = 1): GapCase[] {
  return Object.entries(counts).flatMap(([feature, { n, match }]) => {
    const base = next;
    next += n;
    return Array.from({ length: n }, (_, i): GapCase => ({ features: [feature], cluster: `k${base + Math.floor(i / clusterSize)}`, outcome: i < match ? 'match' : 'diverge' }));
  });
}
const all = (...names: string[]) => new Set(names);
const gapOf = (corpus: Counts, holdout: Counts, alpha = 0.01, features = all(...Object.keys(corpus))) => holdoutGap(side(corpus), side(holdout), { alpha, features });

/** Bernoulli(p). */
const draw = (rng: Rng, p: number) => rng.uint32() / 2 ** 32 < p;

/**
 * Cases of the given per-feature parities in `clusters` clusters of `size` each per feature. With
 * `spread`, each cluster's own parity is p moved up or down by spread × (1 - p), at random, so the
 * mean stays p: a parent and its mutants fail together.
 */
function clustered(rng: Rng, prefix: string, parities: readonly number[], clusters: number, size: number, spread: number): GapCase[] {
  return parities.flatMap((p, f) =>
    Array.from({ length: clusters }, (_, k) => {
      const q = spread === 0 ? p : Math.min(1, Math.max(0, draw(rng, 0.5) ? p + spread * (1 - p) : p - spread * (1 - p)));
      return Array.from({ length: size }, (): GapCase => ({ features: [`opt.f${f}`], cluster: `${prefix}${f}-${k}`, outcome: draw(rng, q) ? 'match' : 'diverge' }));
    }).flat(),
  );
}

describe('distribution functions', () => {
  it('match the standard normal and Student t tables', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-2.326347874)).toBeCloseTo(0.01, 6);
    expect(normalCdf(-6)).toBeLessThan(1e-8);
    expect(studentTCdf(0, 5)).toBeCloseTo(0.5, 10);
    expect(studentTCdf(12.706, 1)).toBeCloseTo(0.975, 4);
    expect(studentTCdf(2.228, 10)).toBeCloseTo(0.975, 4);
    expect(studentTCdf(-2.508, 22)).toBeCloseTo(0.01, 4);
    expect(studentTCdf(1.96, 1e6)).toBeCloseTo(normalCdf(1.96), 5);
    expect(studentTCdf(Infinity, 3)).toBe(1);
  });
});

describe('holdoutGap', () => {
  it('flags a lookup table: perfect on the corpus, wrong on almost every fresh case', () => {
    const features = ['opt.c', 'opt.l', 'opt.w', 'base'];
    const gap = gapOf(Object.fromEntries(features.map((f) => [f, { n: 30, match: 30 }])), Object.fromEntries(features.map((f) => [f, { n: 25, match: 3 }])));
    expect(gap.corpus).toBe(1);
    expect(gap.holdout).toBeCloseTo(0.12);
    expect(gap.gap).toBeCloseTo(0.88);
    expect(gap.pValue).toBeLessThan(1e-10);
    expect(gap.significant).toBe(true);
    expect(gap.features.map((f) => f.feature)).toEqual(['base', 'opt.c', 'opt.l', 'opt.w']);
    expect(gap.clusters).toEqual({ corpus: 120, holdout: 100 });
  });

  it('does not flag a gap of a few cases, nor a holdout that does better than the corpus', () => {
    const corpus = { 'opt.a': { n: 100, match: 90 }, 'opt.b': { n: 100, match: 80 } };
    expect(gapOf(corpus, { 'opt.a': { n: 50, match: 44 }, 'opt.b': { n: 50, match: 39 } }).significant).toBe(false);
    const better = gapOf(corpus, { 'opt.a': { n: 50, match: 50 }, 'opt.b': { n: 50, match: 50 } });
    expect(better.gap).toBeLessThan(0);
    expect(better.pValue).toBeGreaterThan(0.99);
    expect(better.significant).toBe(false);
  });

  it('gives no gap, and never flags, a candidate that matches everything on both sides', () => {
    expect(gapOf({ 'opt.a': { n: 40, match: 40 } }, { 'opt.a': { n: 7, match: 7 } })).toMatchObject({ corpus: 1, holdout: 1, gap: 0, pValue: 1, significant: false });
  });

  it('compares feature by feature, so a holdout that hits the features in other proportions has no gap', () => {
    // 95% on opt.a and 50% on opt.b on both sides, but the holdout is mostly opt.b: pooled over
    // cases, the holdout would look 30 points worse.
    const gap = gapOf({ 'opt.a': { n: 200, match: 190 }, 'opt.b': { n: 20, match: 10 } }, { 'opt.a': { n: 20, match: 19 }, 'opt.b': { n: 200, match: 100 } });
    expect(gap.gap).toBeCloseTo(0);
    expect(gap.significant).toBe(false);
  });

  it('only compares the features asked for that both sides have a scored case of', () => {
    const corpus = { 'opt.a': { n: 20, match: 20 }, 'opt.b': { n: 5, match: 0 }, 'opt.c': { n: 20, match: 20 } };
    const fresh = { 'opt.a': { n: 10, match: 10 }, 'opt.b': { n: 10, match: 10 }, 'opt.d': { n: 10, match: 0 } };
    expect(gapOf(corpus, fresh, 0.01, all('opt.a', 'opt.c', 'opt.d')).features.map((f) => f.feature)).toEqual(['opt.a']);
    expect(gapOf(corpus, { 'opt.z': { n: 10, match: 0 } })).toMatchObject({ features: [], gap: null, pValue: null, significant: false });
    // Excluded cases (waived, flaky-reference) don't count on either side.
    const excluded: GapCase[] = Array.from({ length: 30 }, (_, i) => ({ features: ['opt.a'], cluster: `x${i}`, outcome: 'excluded' }));
    expect(holdoutGap(side({ 'opt.a': { n: 20, match: 20 } }), excluded, { alpha: 0.01, features: all('opt.a') }).features).toEqual([]);
  });

  it(`needs ${MIN_GAP_CASES} scored cases per feature on each side`, () => {
    const corpus = side({ 'opt.a': { n: 40, match: 40 }, 'opt.b': { n: 4, match: 4 } });
    const compared = holdoutGap(corpus, side({ 'opt.a': { n: 4, match: 0 }, 'opt.b': { n: 40, match: 0 } }), { alpha: 0.01, features: all('opt.a', 'opt.b') });
    expect(compared).toMatchObject({ features: [], gap: null, significant: false });
    expect(holdoutGap(corpus, side({ 'opt.a': { n: 4, match: 0 } }), { alpha: 0.01, features: all('opt.a'), minCases: 4 }).features.map((f) => f.feature)).toEqual(['opt.a']);
  });

  it('does not read a gap of a fraction of a case as significant when parity is near 0% on both sides', () => {
    // 1 match in 500 on the corpus, none of 40 in the holdout, in each of 30 features, the
    // corpus's match being the same case: without the continuity correction p is about 0.003.
    const features = Array.from({ length: 30 }, (_, f) => `opt.f${f}`);
    const corpus: GapCase[] = [
      { features, cluster: 'lucky', outcome: 'match' },
      ...features.flatMap((f) => Array.from({ length: 499 }, (_, i): GapCase => ({ features: [f], cluster: `c${f}-${i % 100}`, outcome: 'diverge' }))),
    ];
    const holdout = features.flatMap((f) => Array.from({ length: 40 }, (_, i): GapCase => ({ features: [f], cluster: `h${f}-${i % 20}`, outcome: 'diverge' })));
    const gap = holdoutGap(corpus, holdout, { alpha: 0.05, features: new Set(features) });
    expect(gap.gap).toBeCloseTo(0.002);
    expect(gap.significant).toBe(false);
  });

  it('counts a case without tags in base, as scoring does', () => {
    const untagged: GapCase[] = Array.from({ length: 10 }, (_, i) => ({ features: [], cluster: `u${i}`, outcome: 'diverge' }));
    const gap = holdoutGap(side({ base: { n: 20, match: 20 } }), untagged, { alpha: 0.01, features: all('base') });
    expect(gap.features).toEqual([{ feature: 'base', corpus: { match: 20, scored: 20 }, holdout: { match: 0, scored: 10 } }]);
    expect(gap.significant).toBe(true);
  });

  it('weighs a cluster of cases that fail together as less evidence than as many independent cases', () => {
    const corpus = { 'opt.a': { n: 200, match: 190 } };
    const fresh = { 'opt.a': { n: 100, match: 75 } };
    const independent = holdoutGap(side(corpus), side(fresh), { alpha: 0.01, features: all('opt.a') });
    // The same counts, the cases being 20 parents' mutants of 5 each.
    const grouped = holdoutGap(side(corpus), side(fresh, 5), { alpha: 0.01, features: all('opt.a') });
    expect(independent.significant).toBe(true);
    expect(grouped.pValue!).toBeGreaterThan(independent.pValue!);
    expect(grouped.clusters.holdout).toBe(20);
  });

  it('refuses an alpha outside (0, 1)', () => {
    const s = side({ 'opt.a': { n: 20, match: 20 } });
    for (const alpha of [0, 1, -0.1, Number.NaN]) expect(() => holdoutGap(s, s, { alpha, features: all('opt.a') })).toThrow(RangeError);
  });

  // A fresh seed moves holdout parity by chance; an honest candidate must fail about alpha of the
  // time, not more. Clustered cases are the hard part: a test that assumes independent cases flags
  // them far too often.
  it('flags an honest candidate at most about alpha of the time, independent or clustered cases', () => {
    const rng = createRng('holdout false alarms', 'v1');
    const parities = [0.99, 0.97, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6];
    const features = new Set(parities.map((_, f) => `opt.f${f}`));
    const rate = (trials: number, alpha: number, clusters: number, size: number, spread: number) => {
      let alarms = 0;
      for (let t = 0; t < trials; t++) {
        const corpus = clustered(rng, 'c', parities, clusters, size, spread);
        if (holdoutGap(corpus, clustered(rng, 'h', parities, clusters, size, spread), { alpha, features }).significant) alarms++;
      }
      return alarms / trials;
    };
    // Independent cases: the pooled two-proportion test with Yates's correction, which errs on the
    // side of not flagging.
    expect(rate(1500, 0.05, 40, 1, 0)).toBeLessThan(0.06);
    // Clusters of 6 whose parity varies widely: still at most about alpha.
    expect(rate(1500, 0.05, 10, 6, 1)).toBeLessThan(0.08);
  }, 60_000);
});

describe('holdoutParity', () => {
  it('is the mean of per-feature parity over the features asked for, with an interval', () => {
    const p = holdoutParity(side({ 'opt.a': { n: 40, match: 30 }, 'opt.b': { n: 40, match: 40 }, 'opt.z': { n: 10, match: 0 } }), all('opt.a', 'opt.b'));
    expect(p.parity).toBeCloseTo(0.875);
    expect(p.features).toBe(2);
    expect(p.ci95![0]).toBeLessThan(0.875);
    expect(p.ci95![1]).toBeGreaterThan(0.875);
    expect(holdoutParity(side({ 'opt.z': { n: 10, match: 0 } }), all('opt.a'))).toEqual({ parity: null, ci95: null, features: 0 });
  });

  it("doesn't call 100% on a few cases certain", () => {
    const p = holdoutParity(side({ 'opt.a': { n: 7, match: 7 } }), all('opt.a'));
    expect(p.ci95![1]).toBe(1);
    expect(p.ci95![0]).toBeLessThan(0.9);
  });

  it('covers the true parity about 95% of the time, also with clustered cases', { timeout: 60_000 }, () => {
    const rng = createRng('holdout interval', 'v1');
    const parities = [0.9, 0.8, 0.95, 0.7, 0.99];
    const truth = parities.reduce((a, b) => a + b) / parities.length;
    const features = new Set(parities.map((_, f) => `opt.f${f}`));
    for (const [clusters, size, spread] of [
      [50, 1, 0],
      [15, 6, 1],
    ] as const) {
      let inside = 0;
      const trials = 1000;
      for (let t = 0; t < trials; t++) {
        const [lo, hi] = holdoutParity(clustered(rng, 'h', parities, clusters, size, spread), features).ci95!;
        if (lo <= truth && truth <= hi) inside++;
      }
      expect(inside / trials, `${clusters} clusters of ${size}`).toBeGreaterThan(0.92);
    }
  });
});

describe('gapCluster', () => {
  it('ties cases with the same argv and environment, whatever their input', () => {
    expect(gapCluster({ argv: ['-n', 'a'], env: { B: '1', A: '2' } })).toBe(gapCluster({ argv: ['-n', 'a'], env: { A: '2', B: '1' } }));
    expect(gapCluster({ argv: ['-n', 'a'], env: {} })).not.toBe(gapCluster({ argv: ['-n a'], env: {} }));
    expect(gapCluster({ argv: ['-n'], env: {} })).not.toBe(gapCluster({ argv: ['-n'], env: { A: '' } }));
  });
});

describe('holdout settings', () => {
  it('reads holdout.fresh_cases and holdout.gap_alpha, with the documented defaults', () => {
    const base = { version: 1, reference: { cmd: 'a' } };
    expect(holdoutSettings(parseConfig(base))).toEqual({ freshCases: DEFAULT_FRESH_CASES, gapAlpha: DEFAULT_GAP_ALPHA });
    expect(DEFAULT_FRESH_CASES).toBe(1000);
    expect(DEFAULT_GAP_ALPHA).toBe(0.01);
    expect(holdoutSettings(parseConfig({ ...base, holdout: { fresh_cases: 0, gap_alpha: 0.05 } }))).toEqual({ freshCases: 0, gapAlpha: 0.05 });
    for (const holdout of [{ fresh_cases: -1 }, { fresh_cases: 1.5 }, { gap_alpha: 0 }, { gap_alpha: 1 }, { seed: 3 }]) {
      expect(() => parseConfig({ ...base, holdout })).toThrow(/holdout/);
    }
  });

  it('draws a new seed each time', () => {
    const seeds = new Set(Array.from({ length: 20 }, () => freshHoldoutSeed()));
    expect(seeds.size).toBe(20);
    for (const s of seeds) expect(Number.isSafeInteger(s)).toBe(true);
  });
});

// The whole holdout, generated by the real generator, with programs simulated in-process so that
// 100 seeds take seconds: the reference's output depends on all of its input.
describe('fresh holdout across 100 seeds', () => {
  const spec: CliSpec = parseCliSpec({
    version: 1,
    program: 'frob',
    flags: [
      { names: ['-n', '--numeric'], feature: 'opt.numeric', arity: 0 },
      { names: ['-r', '--reverse'], feature: 'opt.reverse', arity: 0 },
      { names: ['-k', '--key'], feature: 'opt.key', arity: 1, values: [{ name: 'N', type: 'int' }] },
      { names: ['--sort'], feature: 'opt.sort', arity: 1, values: [{ name: 'WORD', type: 'enum', choices: ['numeric', 'month'] }] },
    ],
    forms: [{ usage: 'frob [OPTION]... [FILE]...', args: [{ name: 'FILE', type: 'path', arity: '*' }] }],
  });
  const seeds = [new TextEncoder().encode('banana\napple\n10\n9\nJan\nFeb\n'), new TextEncoder().encode('3\n1\n2\n')];
  const decoder = new TextDecoder();
  const inputs = (c: CanonicalCase, blobs: ReadonlyMap<string, Uint8Array>) => {
    const content = (ref: string) => decoder.decode(blobs.get(ref)!);
    return JSON.stringify([c.argv, c.stdin === null ? null : content(c.stdin), Object.entries(c.fixtures).map(([p, ref]) => `${p}=${content(ref)}`)]);
  };
  const observation = (stdout: string) =>
    canonicalObservation({
      exit: 0,
      signal: null,
      timeout: false,
      stdout: blobRef(stdout),
      stderr: blobRef(''),
      fs: { created: {}, modified: {}, deleted: [] },
      time_ms: { wall: 1, user: null, sys: null },
      rss_kb: null,
      runs: 1,
      stable: true,
    });
  const observe: ObserveReference = async (cases, blobs) => cases.map((c) => observation(inputs(c, blobs)));
  const generator = { generator: 'v1' as const, minCasesPerFeature: 20, observe, seeds };
  /** The cases as the gap test sees them, for a candidate given as whether it gets each case right. */
  const gapCases = (cases: readonly CanonicalCase[], right: (c: CanonicalCase) => boolean): GapCase[] =>
    cases.map((c) => ({ features: c.features, cluster: gapCluster(c), outcome: right(c) ? 'match' : 'diverge' }));

  it('flags a lookup table on almost every seed, and honest candidates about alpha of the time at most (done when)', { timeout: 300_000 }, async () => {
    const corpus = await generateCorpus(spec, { ...generator, seed: 42, budget: 1000 });
    const blobs = new Map(corpus.blobs);
    const ids = new Set(corpus.cases.map((c) => c.case.id));
    // Like `run`, compare the byte mutants on both sides.
    const corpusMutants = corpus.cases.filter((c) => c.strategy === 'mutation').map((c) => c.case);
    const features = new Set(corpus.cases.flatMap((c) => (c.case.features.length === 0 ? ['base'] : c.case.features)));
    const stdin = (c: CanonicalCase) => (c.stdin === null ? new Uint8Array() : blobs.get(c.stdin)!);
    const candidates: Record<string, (c: CanonicalCase) => boolean> = {
      // A table of the corpus's expected outputs: right exactly on the corpus.
      lookup: (c) => ids.has(c.id),
      correct: () => true,
      // Honest ports with a bug tied to the case: these fail together across a parent's mutants.
      'wrong with -n and -r together': (c) => !(c.argv.includes('-n') && c.argv.includes('-r')),
      'wrong with 5 or more arguments': (c) => c.argv.length < 5,
      'wrong with fewer than 3 arguments': (c) => c.argv.length >= 3,
      'wrong on bytes above 126': (c) => !stdin(c).some((b) => b > 126),
      'wrong on 1 case in 8': (c) => Number.parseInt(c.id.slice(-2), 16) % 8 !== 0,
    };
    const flagged = Object.fromEntries(Object.keys(candidates).map((name) => [name, 0]));
    let mutants = 0;
    for (let seed = 1000; seed < 1100; seed++) {
      const holdout = await generateFreshHoldout(spec, { ...generator, seed, cases: 400, corpus: ids });
      expect(holdout.cases.some((c) => ids.has(c.id))).toBe(false);
      for (const [ref, bytes] of holdout.blobs) blobs.set(ref, bytes);
      const fresh = holdout.cases.filter((_, i) => holdout.strategies[i] === 'mutation');
      mutants += fresh.length;
      for (const [name, right] of Object.entries(candidates)) {
        if (holdoutGap(gapCases(corpusMutants, right), gapCases(fresh, right), { alpha: 0.01, features }).significant) flagged[name]!++;
      }
    }
    expect(mutants / 100).toBeGreaterThan(250);
    expect(flagged.lookup).toBeGreaterThanOrEqual(98);
    expect(flagged.correct).toBe(0);
    // About 1 each at alpha 0.01; 5 or more would mean the test is not calibrated.
    for (const name of Object.keys(candidates).filter((n) => n !== 'lookup' && n !== 'correct')) expect(flagged[name], name).toBeLessThan(5);
  });

  // A large CLI: the generator spends most of a 700-case holdout on argv cases, leaving about one
  // byte mutant per two features, and pairwise cases carry dozens of features each.
  it('stays calibrated on a large CLI with few byte-mutated cases per feature', { timeout: 300_000 }, async () => {
    const flags = [
      ...Array.from({ length: 120 }, (_, j) => ({ names: [`--b${j}`], feature: `opt.b${j}`, arity: 0 as const })),
      ...Array.from({ length: 40 }, (_, j) => ({ names: [`--i${j}`], feature: `opt.i${j}`, arity: 1 as const, values: [{ name: 'N', type: 'int' as const }] })),
      ...Array.from({ length: 20 }, (_, j) => ({ names: [`--e${j}`], feature: `opt.e${j}`, arity: 1 as const, values: [{ name: 'W', type: 'enum' as const, choices: ['x', 'y', 'z'] }] })),
    ];
    const large = parseCliSpec({ version: 1, program: 'frob', flags, forms: [{ usage: 'frob [OPTION]... [FILE]...', args: [{ name: 'FILE', type: 'path', arity: '*' }] }] });
    const corpus = await generateCorpus(large, { ...generator, seed: 42, budget: 1000 });
    const blobs = new Map(corpus.blobs);
    const ids = new Set(corpus.cases.map((c) => c.case.id));
    const corpusMutants = corpus.cases.filter((c) => c.strategy === 'mutation').map((c) => c.case);
    const features = new Set(corpus.cases.flatMap((c) => (c.case.features.length === 0 ? ['base'] : c.case.features)));
    const input = (c: CanonicalCase) => [c.stdin, ...Object.values(c.fixtures)].flatMap((ref) => (ref === null ? [] : [blobs.get(ref)!]));
    const candidates: Record<string, (c: CanonicalCase) => boolean> = {
      lookup: (c) => ids.has(c.id),
      'wrong with 5 or more arguments': (c) => c.argv.length < 5,
      'wrong with 4 or more arguments': (c) => c.argv.length < 4,
      'wrong with an int flag': (c) => !c.argv.some((a) => a.startsWith('--i')),
      'wrong on inputs over 30 bytes': (c) => !input(c).some((b) => b.length > 30),
      'wrong on 1 case in 8': (c) => Number.parseInt(c.id.slice(-2), 16) % 8 !== 0,
    };
    const flagged = Object.fromEntries(Object.keys(candidates).map((name) => [name, 0]));
    let mutants = 0;
    const trials = 30;
    for (let seed = 2000; seed < 2000 + trials; seed++) {
      const holdout = await generateFreshHoldout(large, { ...generator, seed, cases: 700, corpus: ids });
      for (const [ref, bytes] of holdout.blobs) blobs.set(ref, bytes);
      const fresh = holdout.cases.filter((_, i) => holdout.strategies[i] === 'mutation');
      mutants += fresh.length;
      for (const [name, right] of Object.entries(candidates)) {
        // At alpha 0.05, so that a test running hot shows within 30 seeds.
        if (holdoutGap(gapCases(corpusMutants, right), gapCases(fresh, right), { alpha: 0.05, features }).significant) flagged[name]!++;
      }
    }
    expect(features.size).toBeGreaterThan(150);
    expect(mutants / trials).toBeLessThan(features.size);
    expect(flagged.lookup).toBeGreaterThanOrEqual(trials - 2);
    // About 1.5 each at alpha 0.05; 5 or more of 30 would mean the test runs hot.
    for (const name of Object.keys(candidates).filter((n) => n !== 'lookup')) expect(flagged[name], name).toBeLessThan(5);
  });

  it('spreads the holdout over every feature, like the corpus', async () => {
    const holdout = await generateFreshHoldout(spec, { ...generator, seed: 7, cases: 200, corpus: new Set() });
    const per = new Map<string, number>();
    for (const c of holdout.cases) for (const f of c.features.length === 0 ? ['base'] : c.features) per.set(f, (per.get(f) ?? 0) + 1);
    for (const f of ['opt.numeric', 'opt.reverse', 'opt.key', 'opt.sort']) expect(per.get(f), f).toBeGreaterThanOrEqual(20);
    expect(holdout.observations).toHaveLength(holdout.cases.length);
    expect(holdout.strategies).toHaveLength(holdout.cases.length);
    expect(holdout.strategies).toContain('mutation');
    for (const c of holdout.cases) if (c.stdin !== null) expect(holdout.blobs.has(c.stdin)).toBe(true);
  });

  it('draws other cases for another seed', async () => {
    const a = await generateFreshHoldout(spec, { ...generator, seed: 1, cases: 100, corpus: new Set() });
    const b = await generateFreshHoldout(spec, { ...generator, seed: 2, cases: 100, corpus: new Set() });
    const inA = new Set(a.cases.map((c) => c.id));
    expect(b.cases.filter((c) => inA.has(c.id)).length).toBeLessThan(b.cases.length / 2);
  });
});

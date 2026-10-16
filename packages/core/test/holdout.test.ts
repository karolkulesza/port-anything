import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { DEFAULT_FRESH_CASES, DEFAULT_GAP_ALPHA, freshHoldoutSeed, holdoutGap, holdoutSettings, normalCdf } from '../src/holdout.js';
import { createRng, type Rng } from '../src/rng.js';
import { scoreCandidate, type Score, type ScoredCase } from '../src/score.js';

let next = 0;
/** `n` cases of each feature, `match[f]` of them matching. */
function cases(counts: Record<string, { n: number; match: number }>): ScoredCase[] {
  return Object.entries(counts).flatMap(([feature, { n, match }]) =>
    Array.from({ length: n }, (_, i): ScoredCase => ({ caseId: `c${next++}`, features: [feature], origin: 'generated', verdict: i < match ? 'match' : 'diverge' })),
  );
}
const score = (counts: Record<string, { n: number; match: number }>, minCasesPerFeature = 20) => scoreCandidate(cases(counts), { minCasesPerFeature });
const holdout = (counts: Record<string, { n: number; match: number }>) => score(counts, 1);

/** The per-feature part of a score, which is all the gap reads; scoring thousands of cases per trial is too slow. */
const counts = (c: Record<string, { n: number; match: number }>, inHeadline: boolean) =>
  ({
    features: Object.entries(c).map(([feature, { n, match }]) => ({ feature, scored: n, match, inHeadline })),
  }) as unknown as Score;

/** Binomial(n, p) draw. */
const binomial = (rng: Rng, n: number, p: number) => {
  let x = 0;
  for (let i = 0; i < n; i++) if (rng.uint32() / 2 ** 32 < p) x++;
  return x;
};

describe('normalCdf', () => {
  it('matches the standard normal table', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-2.326347874)).toBeCloseTo(0.01, 6);
    expect(normalCdf(-6)).toBeGreaterThan(0);
    expect(normalCdf(-6)).toBeLessThan(1e-8);
  });
});

describe('holdoutGap', () => {
  it('flags a lookup table: perfect on the corpus, wrong on almost every fresh case', () => {
    const features = Object.fromEntries(['opt.c', 'opt.l', 'opt.w', 'base'].map((f) => [f, { n: 30, match: 30 }]));
    const fresh = Object.fromEntries(['opt.c', 'opt.l', 'opt.w', 'base'].map((f) => [f, { n: 25, match: 3 }]));
    const gap = holdoutGap(score(features), holdout(fresh), 0.01);
    expect(gap.corpus).toBe(1);
    expect(gap.holdout).toBeCloseTo(0.12);
    expect(gap.gap).toBeCloseTo(0.88);
    expect(gap.pValue).toBeLessThan(1e-10);
    expect(gap.significant).toBe(true);
    expect(gap.features.map((f) => f.feature)).toEqual(['base', 'opt.c', 'opt.l', 'opt.w']);
  });

  it('does not flag a gap of a few cases, nor a holdout that does better than the corpus', () => {
    const corpus = score({ 'opt.a': { n: 100, match: 90 }, 'opt.b': { n: 100, match: 80 } });
    expect(holdoutGap(corpus, holdout({ 'opt.a': { n: 50, match: 44 }, 'opt.b': { n: 50, match: 39 } }), 0.01)).toMatchObject({ significant: false });
    const better = holdoutGap(corpus, holdout({ 'opt.a': { n: 50, match: 50 }, 'opt.b': { n: 50, match: 50 } }), 0.01);
    expect(better.gap).toBeLessThan(0);
    expect(better.pValue).toBeGreaterThan(0.99);
    expect(better.significant).toBe(false);
  });

  it('gives no gap, and never flags, a candidate that matches everything on both sides', () => {
    const gap = holdoutGap(score({ 'opt.a': { n: 40, match: 40 } }), holdout({ 'opt.a': { n: 7, match: 7 } }), 0.01);
    expect(gap).toMatchObject({ corpus: 1, holdout: 1, gap: 0, pValue: 1, significant: false });
    expect(gap.holdoutCi95![1]).toBe(1);
    expect(gap.holdoutCi95![0]).toBeLessThan(1); // 7 cases don't prove 100%
  });

  it('compares feature by feature, so a holdout that hits the features in other proportions has no gap', () => {
    // 95% on opt.a and 50% on opt.b on both sides, but the holdout is mostly opt.b: pooled over
    // cases, the holdout would look 30 points worse.
    const corpus = score({ 'opt.a': { n: 200, match: 190 }, 'opt.b': { n: 20, match: 10 } });
    const gap = holdoutGap(corpus, holdout({ 'opt.a': { n: 20, match: 19 }, 'opt.b': { n: 200, match: 100 } }), 0.01);
    expect(gap.gap).toBeCloseTo(0);
    expect(gap.significant).toBe(false);
  });

  it("only compares the corpus headline's features that the holdout has", () => {
    const corpus = score({ 'opt.a': { n: 20, match: 20 }, 'opt.b': { n: 5, match: 0 }, 'opt.help': { n: 20, match: 0 }, 'opt.c': { n: 20, match: 20 } });
    const gap = holdoutGap(corpus, holdout({ 'opt.a': { n: 10, match: 10 }, 'opt.b': { n: 10, match: 10 }, 'opt.help': { n: 10, match: 10 }, 'opt.d': { n: 10, match: 0 } }), 0.01);
    expect(gap.features.map((f) => f.feature)).toEqual(['opt.a']);
    expect(holdoutGap(corpus, holdout({ 'opt.z': { n: 10, match: 0 } }), 0.01)).toMatchObject({ features: [], gap: null, pValue: null, significant: false });
  });

  it('refuses an alpha outside (0, 1)', () => {
    const s = score({ 'opt.a': { n: 20, match: 20 } });
    for (const alpha of [0, 1, -0.1, Number.NaN]) expect(() => holdoutGap(s, s, alpha)).toThrow(RangeError);
  });

  // The false-alarm rate is the reason for the test: a fresh seed moves holdout parity by chance,
  // and an honest candidate must fail about alpha of the time, not more.
  it('flags an honest candidate about alpha of the time when both sides have the same per-feature parity', () => {
    const rng = createRng('holdout false alarms', 'v1');
    const parities = [0.99, 0.97, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.98, 0.93, 0.88, 0.75];
    const trials = 4000;
    for (const alpha of [0.01, 0.05]) {
      let alarms = 0;
      for (let t = 0; t < trials; t++) {
        const corpus: Record<string, { n: number; match: number }> = {};
        const fresh: Record<string, { n: number; match: number }> = {};
        parities.forEach((p, i) => {
          corpus[`opt.f${i}`] = { n: 60, match: binomial(rng, 60, p) };
          fresh[`opt.f${i}`] = { n: 80, match: binomial(rng, 80, p) };
        });
        if (holdoutGap(counts(corpus, true), counts(fresh, false), alpha).significant) alarms++;
      }
      const rate = alarms / trials;
      expect(rate, `alpha ${alpha}`).toBeGreaterThan(alpha / 3);
      expect(rate, `alpha ${alpha}`).toBeLessThan(alpha * 1.6);
    }
  });

  it('puts the holdout parity inside its 95% interval about 95% of the time', () => {
    const rng = createRng('holdout interval', 'v1');
    const parities = [0.9, 0.8, 0.95, 0.7, 0.99];
    const truth = parities.reduce((a, b) => a + b) / parities.length;
    let inside = 0;
    const trials = 2000;
    for (let t = 0; t < trials; t++) {
      const fresh = Object.fromEntries(parities.map((p, i) => [`opt.f${i}`, { n: 50, match: binomial(rng, 50, p) }]));
      const corpus = Object.fromEntries(parities.map((_, i) => [`opt.f${i}`, { n: 20, match: 20 }]));
      const [lo, hi] = holdoutGap(counts(corpus, true), counts(fresh, false), 0.01).holdoutCi95!;
      if (lo <= truth && truth <= hi) inside++;
    }
    expect(inside / trials).toBeGreaterThan(0.93);
    expect(inside / trials).toBeLessThan(0.99);
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

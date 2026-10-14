import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_CASES_PER_FEATURE, isSelfDescriptionFeature, scoreCandidate, type ScoredCase } from '../src/score.js';

let next = 0;
const c = (features: string[], verdict: 'match' | 'diverge', extra: Partial<ScoredCase> = {}): ScoredCase => ({
  caseId: `c${next++}`,
  features,
  origin: 'generated',
  verdict,
  ...extra,
});
/** `n` cases of one feature, the first `diverging` of them diverging. */
const many = (feature: string, n: number, diverging = 0, extra: Partial<ScoredCase> = {}) =>
  Array.from({ length: n }, (_, i) => c([feature], i < diverging ? 'diverge' : 'match', extra));
const feature = (score: ReturnType<typeof scoreCandidate>, name: string) => score.features.find((f) => f.feature === name);

describe('scoreCandidate', () => {
  it('takes the mean of per-feature parity as the headline, so an error-heavy corpus does not inflate it', () => {
    // 1000 cheap, matching error cases and 20 cases of one real feature, half of them wrong.
    const score = scoreCandidate([...many('error.usage', 1000), ...many('opt.l', 20, 10)]);
    expect(score.raw).toEqual({ cases: 1020, scored: 1020, match: 1010, diverge: 10, waived: 0, flakyReference: 0, flakyCandidate: 0, timeouts: 0, parity: 1010 / 1020 });
    expect(score.headline).toBe(0.75);
    expect(score.headlineFeatures).toEqual(['error.usage', 'opt.l']);
  });

  it('counts a case tagged with several features once in each of them', () => {
    const score = scoreCandidate([...many('opt.l', 19), ...many('opt.w', 19), c(['opt.l', 'opt.w'], 'diverge')]);
    expect(feature(score, 'opt.l')).toMatchObject({ cases: 20, scored: 20, match: 19, diverge: 1, parity: 0.95 });
    expect(feature(score, 'opt.w')).toMatchObject({ cases: 20, scored: 20, match: 19, diverge: 1, parity: 0.95 });
    expect(score.raw).toMatchObject({ cases: 39, scored: 39, match: 38, diverge: 1 });
    expect(score.headline).toBeCloseTo(0.95);
  });

  it('scores cases without flags under base, whether tagged base or not tagged at all', () => {
    const score = scoreCandidate([...many('base', 10), ...Array.from({ length: 10 }, () => c([], 'diverge')), ...many('opt.l', 20)]);
    expect(feature(score, 'base')).toMatchObject({ cases: 20, match: 10, parity: 0.5 });
    expect(score.headline).toBe(0.75);
  });

  it('leaves under-sampled features out of the headline and lists them', () => {
    const score = scoreCandidate([...many('opt.l', 20), ...many('opt.x', 1, 1)]);
    expect(score.headline).toBe(1);
    expect(score.underSampled).toEqual(['opt.x']);
    expect(feature(score, 'opt.x')).toMatchObject({ cases: 1, parity: 0, underSampled: true, inHeadline: false });
    expect(DEFAULT_MIN_CASES_PER_FEATURE).toBe(20);
  });

  it('takes the minimum per feature from the options', () => {
    const cases = [...many('opt.l', 20), ...many('opt.x', 5, 5)];
    expect(scoreCandidate(cases, { minCasesPerFeature: 5 })).toMatchObject({ headline: 0.5, underSampled: [], minCasesPerFeature: 5 });
    expect(scoreCandidate(cases, { minCasesPerFeature: 21 })).toMatchObject({ headline: null, headlineFeatures: [], underSampled: ['opt.l', 'opt.x'] });
  });

  it('excludes waived cases from numerator and denominator, never counting them as passes', () => {
    const score = scoreCandidate([...many('opt.l', 20, 4), ...many('opt.l', 10, 10, { waived: true })]);
    expect(feature(score, 'opt.l')).toMatchObject({ cases: 30, scored: 20, match: 16, diverge: 4, waived: 10, parity: 0.8 });
    expect(score.headline).toBe(0.8);
    expect(score.raw).toMatchObject({ cases: 30, scored: 20, match: 16, waived: 10, parity: 0.8 });
  });

  it('applies a waiver only to a case that diverges', () => {
    const score = scoreCandidate(many('opt.l', 20, 0, { waived: true }));
    expect(feature(score, 'opt.l')).toMatchObject({ scored: 20, match: 20, waived: 0 });
  });

  it('decides under-sampling on the cases left after exclusions', () => {
    const score = scoreCandidate([...many('opt.l', 20), ...many('opt.w', 15), ...many('opt.w', 10, 10, { waived: true })]);
    expect(feature(score, 'opt.w')).toMatchObject({ cases: 25, scored: 15, underSampled: true });
  });

  it('gives 100% to a candidate whose only difference is its --help text, listing it as self-description', () => {
    const score = scoreCandidate([...many('opt.l', 20), ...many('base', 20), ...many('opt.help', 20, 20), ...many('opt.version', 3, 3)]);
    expect(score.headline).toBe(1);
    expect(score.headlineFeatures).toEqual(['base', 'opt.l']);
    expect(score.selfDescription).toEqual(['opt.help', 'opt.version']);
    expect(feature(score, 'opt.help')).toMatchObject({ parity: 0, selfDescription: true, underSampled: false, inHeadline: false });
    // Self-description features are reported in their own section, not as under-sampled.
    expect(score.underSampled).toEqual([]);
  });

  it('treats --help, --version and --usage of subcommands, and features the spec marks, as self-description', () => {
    expect(['opt.help', 'opt.version', 'opt.usage', 'cmd.add.opt.help'].map((f) => isSelfDescriptionFeature(f))).toEqual([true, true, true, true]);
    expect(['opt.h', 'opt.helper', 'cmd.help', 'base', 'help'].map((f) => isSelfDescriptionFeature(f))).toEqual([false, false, false, false, false]);
    const score = scoreCandidate([...many('opt.l', 20), ...many('cmd.help', 20, 20), ...many('opt.h', 20, 20)], {
      features: [
        { name: 'cmd.help', selfDescription: true },
        { name: 'opt.h', selfDescription: true },
        { name: 'opt.l', selfDescription: false },
      ],
    });
    expect(score).toMatchObject({ headline: 1, selfDescription: ['cmd.help', 'opt.h'] });
  });

  it('excludes flaky-reference cases and counts flaky-candidate cases and candidate timeouts as divergences', () => {
    const score = scoreCandidate([
      ...many('opt.l', 20),
      ...many('opt.l', 5, 5, { flakyReference: true }),
      ...many('opt.w', 18),
      c(['opt.w'], 'match', { flakyCandidate: true }),
      c(['opt.w'], 'match', { candidateTimeout: true }),
    ]);
    expect(feature(score, 'opt.l')).toMatchObject({ cases: 25, scored: 20, match: 20, flakyReference: 5, parity: 1 });
    expect(feature(score, 'opt.w')).toMatchObject({ cases: 20, scored: 20, match: 18, diverge: 2, flakyCandidate: 1, timeouts: 1, parity: 0.9 });
    expect(score.raw).toMatchObject({ cases: 45, scored: 40, match: 38, diverge: 2, flakyReference: 5, flakyCandidate: 1, timeouts: 1 });
  });

  it('does not let a waiver cover a flaky candidate or a timeout', () => {
    const score = scoreCandidate([...many('opt.l', 18), c(['opt.l'], 'diverge', { waived: true, flakyCandidate: true }), c(['opt.l'], 'diverge', { waived: true, candidateTimeout: true })]);
    expect(feature(score, 'opt.l')).toMatchObject({ scored: 20, diverge: 2, waived: 0, parity: 0.9 });
  });

  it('reports parity per origin with the same counting rules', () => {
    const score = scoreCandidate([
      ...many('opt.l', 20, 0, { origin: 'generated' }),
      ...many('opt.w', 20, 0, { origin: 'generated' }),
      ...many('opt.l', 2, 1, { origin: 'recorded' }),
      ...many('opt.w', 3, 0, { origin: 'recorded' }),
      ...many('opt.help', 3, 3, { origin: 'recorded' }),
    ]);
    expect(score.origins.generated).toEqual({ cases: 40, scored: 40, match: 40, features: 2, parity: 1 });
    // The headline's features (opt.l and opt.w), averaged over the recorded cases: (1/2 + 3/3) / 2.
    expect(score.origins.recorded).toEqual({ cases: 8, scored: 8, match: 4, features: 2, parity: 0.75 });
    expect(score.origins.imported).toEqual({ cases: 0, scored: 0, match: 0, features: 0, parity: null });
  });

  it('lists the spec features that no case covers', () => {
    const score = scoreCandidate([...many('opt.l', 20)], {
      features: [
        { name: 'opt.l', selfDescription: false },
        { name: 'opt.w', selfDescription: false },
        { name: 'opt.help', selfDescription: true },
      ],
    });
    expect(score.untested).toEqual(['opt.help', 'opt.w']);
    expect(feature(score, 'opt.w')).toBeUndefined();
  });

  it('gives no headline for an empty corpus', () => {
    expect(scoreCandidate([])).toMatchObject({ headline: null, headlineFeatures: [], features: [], raw: { cases: 0, scored: 0, parity: null } });
  });

  it('gives a feature whose cases are all excluded no parity', () => {
    const score = scoreCandidate([...many('opt.l', 20), ...many('opt.w', 20, 20, { waived: true })]);
    expect(feature(score, 'opt.w')).toMatchObject({ cases: 20, scored: 0, parity: null, underSampled: true });
    expect(score.headline).toBe(1);
  });

  it('lists features by name and is the same whatever the case order', () => {
    const cases = [...many('opt.w', 20, 3), ...many('base', 20, 1), ...many('opt.l', 20, 7), c(['opt.l', 'opt.z'], 'diverge')];
    const score = scoreCandidate(cases);
    expect(score.features.map((f) => f.feature)).toEqual(['base', 'opt.l', 'opt.w', 'opt.z']);
    expect(scoreCandidate([...cases].reverse())).toEqual(score);
  });

  it('refuses a minimum below 1', () => {
    expect(() => scoreCandidate([], { minCasesPerFeature: 0 })).toThrow(/at least 1/);
  });
});

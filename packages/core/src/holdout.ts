import { randomInt } from 'node:crypto';
import type { Config } from './config.js';
import type { Score } from './score.js';

/** Cases in a fresh holdout when `holdout.fresh_cases` isn't set. */
export const DEFAULT_FRESH_CASES = 1000;
/** Significance level of the corpus-vs-holdout gap when `holdout.gap_alpha` isn't set. */
export const DEFAULT_GAP_ALPHA = 0.01;

/** The fresh holdout's settings, out of `port-anything.yaml`. */
export interface HoldoutSettings {
  /** Cases to generate; 0 turns the holdout off. */
  freshCases: number;
  gapAlpha: number;
}

export function holdoutSettings(config: Config): HoldoutSettings {
  return { freshCases: config.holdout?.fresh_cases ?? DEFAULT_FRESH_CASES, gapAlpha: config.holdout?.gap_alpha ?? DEFAULT_GAP_ALPHA };
}

/**
 * A new seed for a fresh holdout, from the system's random source. It is never stored or printed:
 * nobody, the candidate's author included, can know the cases before the run generates them.
 */
export function freshHoldoutSeed(): number {
  return randomInt(2 ** 47);
}

/** One feature's counts on both sides of the gap. */
export interface GapFeature {
  feature: string;
  corpus: { match: number; scored: number };
  holdout: { match: number; scored: number };
}

/** How a candidate's parity on the corpus compares with its parity on a fresh holdout. */
export interface HoldoutGap {
  /** The corpus headline's features that the holdout has a scored case of; the gap is over these. */
  features: GapFeature[];
  /** Mean of per-feature parity over `features`, on each side; null without a compared feature. */
  corpus: number | null;
  holdout: number | null;
  /** 95% confidence interval of the holdout parity. */
  holdoutCi95: [number, number] | null;
  /** `corpus - holdout`; null without a compared feature. */
  gap: number | null;
  /** One-sided p-value of a gap at least this large if both sides had the same per-feature parity. */
  pValue: number | null;
  alpha: number;
  /** `pValue < alpha`: the candidate does better on the corpus than chance allows. */
  significant: boolean;
}

const Z95 = 1.959963984540054;

/**
 * The gap between a candidate's corpus parity and its fresh-holdout parity, with a one-sided
 * two-proportion test stratified by feature: the gap is the mean over features of (corpus parity -
 * holdout parity), the same mean of per-feature parity the headline takes, and under the null
 * hypothesis (each feature's parity is the same on both sides) its variance is the sum over
 * features of p(1-p)(1/n_corpus + 1/n_holdout) / K^2, p being the feature's pooled parity. Comparing
 * feature by feature means a holdout that hits the features in other proportions than the corpus
 * doesn't move the gap. Only the corpus headline's features count, and of those the ones the
 * holdout has a scored case of. A holdout parity above the corpus parity is never significant.
 */
export function holdoutGap(corpus: Score, holdout: Score, alpha: number): HoldoutGap {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be between 0 and 1, not ${alpha}`);
  const inHoldout = new Map(holdout.features.filter((f) => f.scored > 0).map((f) => [f.feature, f]));
  const features: GapFeature[] = corpus.features.flatMap((c) => {
    const h = inHoldout.get(c.feature);
    return c.inHeadline && h !== undefined ? [{ feature: c.feature, corpus: { match: c.match, scored: c.scored }, holdout: { match: h.match, scored: h.scored } }] : [];
  });
  const k = features.length;
  if (k === 0) return { features, corpus: null, holdout: null, holdoutCi95: null, gap: null, pValue: null, alpha, significant: false };

  let corpusSum = 0;
  let holdoutSum = 0;
  let nullVariance = 0;
  let holdoutVariance = 0;
  for (const { corpus: c, holdout: h } of features) {
    corpusSum += c.match / c.scored;
    holdoutSum += h.match / h.scored;
    const pooled = (c.match + h.match) / (c.scored + h.scored);
    nullVariance += pooled * (1 - pooled) * (1 / c.scored + 1 / h.scored);
    // Agresti-Coull, so a feature at 0% or 100% still adds some uncertainty.
    const adjusted = (h.match + 2) / (h.scored + 4);
    holdoutVariance += (adjusted * (1 - adjusted)) / (h.scored + 4);
  }
  const corpusParity = corpusSum / k;
  const holdoutParity = holdoutSum / k;
  const gap = corpusParity - holdoutParity;
  // With no variance, every feature is at 0% or 100% on both sides alike, so the gap is 0.
  const pValue = nullVariance > 0 ? 1 - normalCdf(gap / (Math.sqrt(nullVariance) / k)) : gap > 0 ? 0 : 1;
  const half = (Z95 * Math.sqrt(holdoutVariance)) / k;
  return {
    features,
    corpus: corpusParity,
    holdout: holdoutParity,
    holdoutCi95: [Math.max(0, holdoutParity - half), Math.min(1, holdoutParity + half)],
    gap,
    pValue,
    alpha,
    significant: pValue < alpha,
  };
}

/** The standard normal distribution function. */
export function normalCdf(z: number): number {
  return z >= 0 ? 1 - erfc(z / Math.SQRT2) / 2 : erfc(-z / Math.SQRT2) / 2;
}

/** Complementary error function for x >= 0, with a fractional error below 1.2e-7 (Numerical Recipes' erfcc). */
function erfc(x: number): number {
  const t = 1 / (1 + x / 2);
  const poly =
    -x * x -
    1.26551223 +
    t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  return t * Math.exp(poly);
}

import { randomInt } from 'node:crypto';
import type { CliSpec } from './cli-spec.js';
import type { Config } from './config.js';
import { generateCorpus, type CorpusStrategy, type GenerateCorpusOptions } from './corpus-generator.js';
import { caseFeatures } from './cluster.js';
import type { CanonicalCase, Observation } from './model.js';

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

export interface GenerateHoldoutOptions extends Omit<GenerateCorpusOptions, 'seed' | 'budget' | 'timeMs'> {
  /** From `freshHoldoutSeed`, so that it isn't stored anywhere. */
  seed: number;
  /** Cases to generate, the ones the corpus already has included. */
  cases: number;
  /** IDs of the corpus's cases, left out of the holdout. */
  corpus: ReadonlySet<string>;
}

export interface FreshHoldout {
  /** The new cases, in the order they were generated. */
  cases: CanonicalCase[];
  /** The reference's behavior on each case while it was generated. */
  observations: Observation[];
  /** How each case was generated: an argv strategy, a byte mutation of a kept case's input, or a token mutation of a committed case. */
  strategies: CorpusStrategy[];
  /** Contents of every stdin and fixture blob the cases reference, by blob ref. */
  blobs: Map<string, Uint8Array>;
  /** Generated cases the corpus already has, left out. */
  inCorpus: number;
}

/**
 * A fresh holdout: cases generated the way the corpus is (same CLI spec, generator, error-path
 * cap and per-feature minimum, so they are spread over the features the same way, round-robin and
 * topped up per feature), from a new seed, minus the few cases the corpus already has.
 */
export async function generateFreshHoldout(spec: CliSpec, options: GenerateHoldoutOptions): Promise<FreshHoldout> {
  const { seed, cases: budget, corpus, ...rest } = options;
  const generated = await generateCorpus(spec, { ...rest, seed, budget });
  const fresh = generated.cases.filter((c) => !corpus.has(c.case.id));
  const blobs = new Map<string, Uint8Array>();
  for (const { case: c } of fresh) {
    for (const ref of [c.stdin, ...Object.values(c.fixtures)]) if (ref !== null) blobs.set(ref, generated.blobs.get(ref)!);
  }
  return { cases: fresh.map((c) => c.case), observations: fresh.map((c) => c.observation), strategies: fresh.map((c) => c.strategy), blobs, inCorpus: generated.cases.length - fresh.length };
}

/** A case as the gap test sees it, for one candidate. */
export interface GapCase {
  /** Its feature tags; a case without tags counts in `base`, as in scoring. */
  features: readonly string[];
  /** Cases with the same cluster were drawn together (see `gapCluster`). */
  cluster: string;
  /** `excluded`: left out of the score (waived, flaky-reference). */
  outcome: 'match' | 'diverge' | 'excluded';
}

/**
 * What ties generated cases together: their argv and environment. A byte mutant keeps its parent's
 * argv and changes only its stdin or files, so a parent and its mutants are one cluster, and which
 * parents a seed happens to draw moves parity far more than the case count suggests.
 */
export function gapCluster(c: Pick<CanonicalCase, 'argv' | 'env'>): string {
  return JSON.stringify([c.argv, Object.entries(c.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
}

/**
 * `gapCluster`, with each token mutant of a committed case (generator v2) in its parent's cluster:
 * a generated case whose stdin, fixtures and environment are a committed case's, and whose argv
 * differs from it in one argument, came from it, and mutants of one parent fail together whichever
 * argument changed. When several committed cases fit, the one with the lowest ID is taken.
 */
export function gapClusters(committed: readonly CanonicalCase[]): (c: CanonicalCase) => string {
  const inputs = (c: CanonicalCase) => JSON.stringify([c.stdin, c.fixtures, gapCluster({ argv: [], env: c.env }), c.argv.length]);
  const parents = new Map<string, CanonicalCase[]>();
  for (const p of [...committed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = inputs(p);
    if (!parents.has(key)) parents.set(key, []);
    parents.get(key)!.push(p);
  }
  return (c) => {
    if (c.origin === 'generated') {
      const parent = parents.get(inputs(c))?.find((p) => p.argv.filter((arg, i) => arg !== c.argv[i]).length === 1);
      if (parent !== undefined) return gapCluster(parent);
    }
    return gapCluster(c);
  };
}

/** One feature's counts on both sides of the gap. */
export interface GapFeature {
  feature: string;
  corpus: { match: number; scored: number };
  holdout: { match: number; scored: number };
}

/** How a candidate's parity on the corpus compares with its parity on a fresh holdout. */
export interface HoldoutGap {
  /** The features compared: of those asked for, the ones both sides have a scored case of. */
  features: GapFeature[];
  /** Mean of per-feature parity over `features`, on each side; null without a compared feature. */
  corpus: number | null;
  holdout: number | null;
  /** `corpus - holdout`; null without a compared feature. */
  gap: number | null;
  /** One-sided p-value of a gap at least this large if both sides had the same per-feature parity. */
  pValue: number | null;
  alpha: number;
  /** `pValue < alpha`: the candidate does better on the corpus than chance allows. */
  significant: boolean;
  /** Clusters (see `gapCluster`) with a scored case of a compared feature, per side. */
  clusters: { corpus: number; holdout: number };
}

/** Scored cases and matches per feature, over the features in `only`. */
function tally(cases: readonly GapCase[], only: ReadonlySet<string>): Map<string, { match: number; scored: number }> {
  const out = new Map<string, { match: number; scored: number }>();
  for (const c of cases) {
    if (c.outcome === 'excluded') continue;
    for (const f of caseFeatures(c.features)) {
      if (!only.has(f)) continue;
      const t = out.get(f) ?? { match: 0, scored: 0 };
      t.scored++;
      if (c.outcome === 'match') t.match++;
      out.set(f, t);
    }
  }
  return out;
}

/**
 * Cluster-robust variance of a mean of per-feature parities (the features in `counts`), each
 * case's deviation taken from `center(feature)`: the sum over clusters of the squared sum of their
 * cases' contributions, with the small-sample factor G/(G-1). Returns the variance and G.
 */
function clusteredVariance(cases: readonly GapCase[], counts: ReadonlyMap<string, { scored: number }>, center: (feature: string) => number): { variance: number; clusters: number } {
  const k = counts.size;
  const sums = new Map<string, number>();
  for (const c of cases) {
    if (c.outcome === 'excluded') continue;
    let u = 0;
    let counted = false;
    for (const f of caseFeatures(c.features)) {
      const t = counts.get(f);
      if (t === undefined) continue;
      u += ((c.outcome === 'match' ? 1 : 0) - center(f)) / t.scored;
      counted = true;
    }
    if (counted) sums.set(c.cluster, (sums.get(c.cluster) ?? 0) + u);
  }
  const g = sums.size;
  let squares = 0;
  for (const u of sums.values()) squares += u * u;
  return { variance: g > 1 ? (g / (g - 1)) * (squares / (k * k)) : 0, clusters: g };
}

/** Scored cases a feature needs on each side to be compared: fewer say next to nothing about its parity. */
export const MIN_GAP_CASES = 5;

/**
 * The gap between a candidate's corpus parity and its fresh-holdout parity, tested one-sided: is
 * the corpus better than chance allows? Both sides are cases generated the same way (the caller
 * passes mutants only: argv cases take a share of a corpus that depends on its budget, so
 * they aren't comparable). The gap is the mean over features of (corpus parity - holdout parity),
 * the same mean of per-feature parity the headline takes, over the features asked for that have
 * at least `minCases` (default `MIN_GAP_CASES`) scored cases on each side;
 * comparing feature by feature means a holdout that hits the features in other proportions doesn't
 * move it. Its variance under the null hypothesis (each feature's parity the same on both sides)
 * is cluster-robust: cases deviate from the feature's pooled parity, and deviations add up within a
 * cluster (see `gapCluster`), since cases of one parent fail together. The gap is reduced by a
 * continuity correction (half a case per side and feature) and the p-value comes from Student's t
 * with one degree of freedom less than the smaller side's clusters. With every case its own
 * cluster this is the pooled two-proportion test with Yates's correction.
 */
export function holdoutGap(corpus: readonly GapCase[], holdout: readonly GapCase[], options: { alpha: number; features: ReadonlySet<string>; minCases?: number }): HoldoutGap {
  const { alpha } = options;
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be between 0 and 1, not ${alpha}`);
  const c = tally(corpus, options.features);
  const h = tally(holdout, options.features);
  const minCases = options.minCases ?? MIN_GAP_CASES;
  const enough = (t: { scored: number } | undefined) => t !== undefined && t.scored >= minCases;
  const names = [...c.keys()].filter((f) => enough(c.get(f)) && enough(h.get(f))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const features: GapFeature[] = names.map((feature) => ({ feature, corpus: c.get(feature)!, holdout: h.get(feature)! }));
  const k = features.length;
  if (k === 0) return { features, corpus: null, holdout: null, gap: null, pValue: null, alpha, significant: false, clusters: { corpus: 0, holdout: 0 } };

  const compared = new Set(names);
  const only = (m: Map<string, { match: number; scored: number }>) => new Map([...m].filter(([f]) => compared.has(f)));
  const cc = only(c);
  const hh = only(h);
  const pooled = (f: string) => (cc.get(f)!.match + hh.get(f)!.match) / (cc.get(f)!.scored + hh.get(f)!.scored);
  const corpusParity = features.reduce((sum, f) => sum + f.corpus.match / f.corpus.scored, 0) / k;
  const holdoutParity = features.reduce((sum, f) => sum + f.holdout.match / f.holdout.scored, 0) / k;
  const gap = corpusParity - holdoutParity;
  const a = clusteredVariance(corpus, cc, pooled);
  const b = clusteredVariance(holdout, hh, pooled);
  const se = Math.sqrt(a.variance + b.variance);
  const df = Math.max(1, Math.min(a.clusters, b.clusters) - 1);
  // Continuity correction (Yates), per feature: half a case on each side. Without it, a gap of a
  // fraction of a case reads as significant when parity is near 0% or 100% on both sides, and a
  // small holdout of a large CLI, whose few mutants count in a feature mostly through parents that
  // carry dozens of features, reads a difference in that mix as a gap. It makes the test
  // conservative when cases are independent.
  const correction = features.reduce((sum, f) => sum + 0.5 * (1 / f.corpus.scored + 1 / f.holdout.scored), 0) / k;
  const corrected = gap > 0 ? Math.max(0, gap - correction) : gap;
  // With no variance, every feature is at 0% or 100% on both sides alike.
  const pValue = se > 0 ? 1 - studentTCdf(corrected / se, df) : corrected > 0 ? 0 : 1;
  return { features, corpus: corpusParity, holdout: holdoutParity, gap, pValue, alpha, significant: pValue < alpha, clusters: { corpus: a.clusters, holdout: b.clusters } };
}

/** A fresh holdout's parity, as the headline computes it, with a 95% confidence interval. */
export interface HoldoutParity {
  /** Mean of per-feature parity over `features`; null when the holdout has no scored case of them. */
  parity: number | null;
  ci95: [number, number] | null;
  /** Features it is the mean over. */
  features: number;
}

/**
 * Parity over the holdout's scored cases of the given features (the corpus headline's), with a
 * 95% interval from the cluster-robust variance (see `holdoutGap`), never narrower than the one
 * independent cases would give (Agresti-Coull per feature, so 100% on a few cases isn't certain).
 */
export function holdoutParity(holdout: readonly GapCase[], features: ReadonlySet<string>): HoldoutParity {
  const counts = tally(holdout, features);
  const k = counts.size;
  if (k === 0) return { parity: null, ci95: null, features: 0 };
  let sum = 0;
  let independent = 0;
  for (const t of counts.values()) {
    sum += t.match / t.scored;
    const adjusted = (t.match + 2) / (t.scored + 4);
    independent += (adjusted * (1 - adjusted)) / (t.scored + 4);
  }
  const parity = sum / k;
  const clustered = clusteredVariance(holdout, counts, (f) => counts.get(f)!.match / counts.get(f)!.scored);
  const variance = Math.max(clustered.variance, independent / (k * k));
  const quantile = clustered.clusters > 1 ? studentTQuantile975(clustered.clusters - 1) : Z95;
  const half = quantile * Math.sqrt(variance);
  return { parity, ci95: [Math.max(0, parity - half), Math.min(1, parity + half)], features: k };
}

const Z95 = 1.959963984540054;

/** The 97.5% quantile of Student's t with `df` degrees of freedom, by bisection on the distribution function. */
function studentTQuantile975(df: number): number {
  let lo = 0;
  let hi = 20;
  if (studentTCdf(hi, df) < 0.975) return 1000; // df < 1: no useful interval
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < 0.975) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Student's t distribution function with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError(`df must be positive, not ${df}`);
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const tail = regularizedBeta(df / (df + t * t), df / 2, 0.5) / 2;
  return t > 0 ? 1 - tail : tail;
}

/** The regularized incomplete beta function I_x(a, b) (Numerical Recipes' betai). */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  const clamp = (v: number) => (Math.abs(v) < tiny ? tiny : v);
  let c = 1;
  let d = 1 / clamp(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / clamp(1 + aa * d);
    c = clamp(1 + aa / c);
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / clamp(1 + aa * d);
    c = clamp(1 + aa / c);
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 3e-14) break;
  }
  return h;
}

/** ln Γ(z) for z > 0 (Lanczos, g = 7). */
function logGamma(z: number): number {
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x0 = z - 1;
  let x = g[0]!;
  for (let i = 1; i < 9; i++) x += g[i]! / (x0 + i);
  const t = x0 + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x0 + 0.5) * Math.log(t) - t + Math.log(x);
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

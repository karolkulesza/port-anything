/** One case's wall-clock times on both sides, and whether either side timed out. */
export interface TimedCase {
  reference: { wall: number; timeout: boolean };
  candidate: { wall: number; timeout: boolean };
}

/** How much slower a candidate ran than the reference, and whether that is over the configured maximum. */
export interface Slowdown {
  /** Median of the per-case ratios of candidate to reference wall time; null without a timed case. */
  ratio: number | null;
  /** Cases the median is taken over. */
  cases: number;
  /** `compare.max_slowdown`, or null when no maximum is set. */
  max: number | null;
  /** True when the ratio is above the maximum. */
  exceeded: boolean;
}

/**
 * The slowdown gate: the median, over the cases, of the candidate's wall time divided by the
 * reference's. A median, so a few cases dominated by start-up noise can't decide it. Cases the
 * reference timed out on (no reference time to compare with) or ran in no measurable time are left
 * out; a case only the candidate timed out on counts with the time it ran until it was stopped.
 */
export function measureSlowdown(cases: readonly TimedCase[], max?: number): Slowdown {
  const ratios = cases
    .filter((c) => !c.reference.timeout && c.reference.wall > 0)
    .map((c) => c.candidate.wall / c.reference.wall)
    .sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  const ratio = ratios.length === 0 ? null : ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { ratio, cases: ratios.length, max: max ?? null, exceeded: max !== undefined && ratio !== null && ratio > max };
}

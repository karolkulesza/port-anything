import { describe, expect, it } from 'vitest';
import { measureSlowdown, type TimedCase } from '../src/slowdown.js';

/** A case where the reference took `reference` ms and the candidate `candidate` ms. */
const t = (reference: number, candidate: number, timeouts: { reference?: boolean; candidate?: boolean } = {}): TimedCase => ({
  reference: { wall: reference, timeout: timeouts.reference ?? false },
  candidate: { wall: candidate, timeout: timeouts.candidate ?? false },
});

describe('measureSlowdown', () => {
  it('takes the median of the per-case time ratios', () => {
    expect(measureSlowdown([t(10, 30), t(10, 10), t(10, 50)])).toEqual({ ratio: 3, cases: 3, max: null, exceeded: false });
    // An even count: the mean of the two middle ratios.
    expect(measureSlowdown([t(10, 10), t(10, 20), t(10, 40), t(10, 80)]).ratio).toBe(3);
  });

  it('is not moved by a few very slow cases, since it is a median', () => {
    expect(measureSlowdown([t(10, 10), t(10, 11), t(10, 12), t(1, 1000), t(1, 1000)]).ratio).toBeCloseTo(1.2);
  });

  it('fails when the median ratio is above the maximum, not when it equals it', () => {
    expect(measureSlowdown([t(10, 25)], 2)).toEqual({ ratio: 2.5, cases: 1, max: 2, exceeded: true });
    expect(measureSlowdown([t(10, 20)], 2)).toMatchObject({ ratio: 2, exceeded: false });
    expect(measureSlowdown([t(10, 5)], 1)).toMatchObject({ ratio: 0.5, exceeded: false });
  });

  it('leaves out cases the reference timed out on, and keeps those only the candidate timed out on', () => {
    const slowdown = measureSlowdown([t(10, 10), t(500, 500, { reference: true, candidate: true }), t(10, 500, { candidate: true })], 2);
    expect(slowdown).toEqual({ ratio: 25.5, cases: 2, max: 2, exceeded: true });
  });

  it('leaves out cases with no measurable reference time', () => {
    expect(measureSlowdown([t(0, 5), t(10, 10)])).toMatchObject({ ratio: 1, cases: 1 });
  });

  it('has no ratio, and does not fail, without a timed case', () => {
    expect(measureSlowdown([], 2)).toEqual({ ratio: null, cases: 0, max: 2, exceeded: false });
    expect(measureSlowdown([t(10, 10, { reference: true })], 2)).toEqual({ ratio: null, cases: 0, max: 2, exceeded: false });
  });
});

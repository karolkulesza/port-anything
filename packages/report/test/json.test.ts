import { describe, expect, it } from 'vitest';
import { ReportJsonSchema, badgeText, percent, renderReportHtml, reportJson, reportJsonSchema } from '../src/index.js';
import { INPUT, id } from './three-candidates.js';

describe('reportJson', () => {
  const json = reportJson(INPUT);
  const text = `${JSON.stringify(json, null, 2)}\n`;

  it('is valid against its schema once written and read back (done when)', () => {
    expect(ReportJsonSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it('keeps the committed JSON Schema in step with the schema the code checks', async () => {
    await expect(`${JSON.stringify(reportJsonSchema(), null, 2)}\n`).toMatchFileSnapshot('../report.schema.json');
    expect(reportJsonSchema()).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false });
  });

  it('renders a 3-candidate run (snapshot)', async () => {
    await expect(text).toMatchFileSnapshot('__snapshots__/three-candidates.json');
  });

  it('has the headline the HTML report shows, and the badge text, for each candidate', () => {
    const html = renderReportHtml(INPUT);
    expect(json.candidates.map((c) => c.candidate)).toEqual([1, 2, 3]);
    for (const [i, c] of json.candidates.entries()) {
      const score = INPUT.candidates[i]!.score;
      expect(c.headline).toBe(score.headline);
      expect(c.badge).toBe(badgeText(score));
      expect(c.badge).toContain(`parity ${percent(c.headline!)} · `);
      expect(html).toContain(`<strong>${percent(c.headline!)}</strong>`);
    }
    // Candidate 2: (23/25 + 21/22) / 2, as the HTML matrix shows it (93.7%).
    expect(json.candidates[1]!.headline).toBeCloseTo((23 / 25 + 21 / 22) / 2, 12);
    expect(json.candidates[1]!.badge).toBe('parity 93.7% · 2 features · 55 cases');
  });

  it('carries the counting rules: per-feature flags, untested features, waivers and per-origin parity', () => {
    const c3 = json.candidates[2]!;
    expect(c3.features.find((f) => f.feature === 'base')).toEqual({
      feature: 'base', parity: 23 / 24, cases: 25, scored: 24, match: 23, diverge: 1, waived: 1, flaky_reference: 0, flaky_candidate: 0, timeouts: 0, timeout_recovered: 0,
      self_description: false, under_sampled: false, in_headline: true,
    });
    expect(c3.under_sampled).toEqual(['opt.x']);
    expect(json.candidates[0]!.untested).toEqual(['opt.z']);
    expect(c3.waivers).toEqual([
      { waiver: 1, cases: 2, share: 2 / 55, large: false },
      { waiver: 2, cases: 1, share: 1 / 55, large: false },
    ]);
    expect(Object.keys(c3.origins).sort()).toEqual(['generated', 'imported', 'recorded']);
    expect(json.waivers[1]).toEqual({ waiver: 2, match: { feature: 'base', field: 'exit', shape: 'exit-code' }, category: 'reference-bug', reason: 'the original exits 0 after "write error"' });
    expect(json.min_cases_per_feature).toBe(20);
  });

  it('lists the cases scored on a re-run after a candidate timeout, with their count', () => {
    const [c1, c2] = json.candidates;
    expect(c2!.timeout_recovered).toEqual([id(5), id(30)]);
    expect(c2!.raw).toMatchObject({ timeout_recovered: 2, timeouts: 0 });
    expect(c2!.features.find((f) => f.feature === 'opt.n')).toMatchObject({ timeout_recovered: 1 });
    expect(c1!.timeout_recovered).toEqual([]);
    expect(c1!.raw.timeout_recovered).toBe(0);
  });

  it('names each cluster in words, with its repro case by ID, null when the report has none', () => {
    expect(json.clusters.map((k) => [k.cluster, k.candidate, k.description, k.repro])).toEqual([
      [1, 2, 'stdout number-value', id(3)],
      [2, 2, 'stdout other', null],
      [3, 3, 'exit 0 vs 2', id(26)],
    ]);
  });

  it('rejects what the format does not allow', () => {
    const parse = (change: (j: Record<string, unknown>) => void) => {
      const j = JSON.parse(text) as Record<string, unknown>;
      change(j);
      return ReportJsonSchema.safeParse(j).success;
    };
    expect(parse(() => {})).toBe(true);
    expect(parse((j) => (j.version = 2))).toBe(false);
    expect(parse((j) => (j.extra = true))).toBe(false);
    expect(parse((j) => ((j.candidates as Record<string, unknown>[])[0]!.headline = 1.5))).toBe(false);
    expect(parse((j) => (j.candidates = []))).toBe(false);
    expect(parse((j) => ((j.clusters as Record<string, unknown>[])[0]!.repro = 'c_00000003'))).toBe(false);
    expect(parse((j) => delete (j.candidates as Record<string, unknown>[])[0]!.origins)).toBe(false);
  });
});

import { COMPARED_FIELDS, CaseIdSchema, DEFAULT_MIN_CASES_PER_FEATURE, DIFF_SHAPES, WaiverSchema, describeSignature, type CaseCounts } from '@port-anything/core';
import { z } from 'zod';
import { badgeText } from './badge.js';
import type { ReportInput } from './html.js';

const Count = z.number().int().nonnegative();
/** A share from 0 to 1; null when nothing counts. */
const Parity = z.number().min(0).max(1).nullable();

const COUNTS = {
  /** Every case, excluded ones included. */
  cases: Count,
  /** The cases that count: all but waived and flaky-reference ones. */
  scored: Count,
  match: Count,
  diverge: Count,
  waived: Count,
  flaky_reference: Count,
  /** Of the diverging cases, those where the candidate was flaky. */
  flaky_candidate: Count,
  /** Of the diverging cases, those where the candidate timed out. */
  timeouts: Count,
  /** Cases, whatever their outcome, scored on a candidate re-run after its first run timed out. */
  timeout_recovered: Count,
};

const OriginSchema = z.strictObject({ cases: Count, scored: Count, match: Count, features: Count, parity: Parity });

const HoldoutSchema = z.strictObject({
  match: Count,
  diverge: Count,
  /** Mean of per-feature parity over the holdout's cases of the headline's features. */
  parity: Parity,
  ci95: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).nullable(),
  /** Features `parity` is the mean over. */
  features: Count,
  /** The gap test, on the mutated cases of the corpus and the holdout; null when it couldn't run (`no_gap` says why). */
  gap: z
    .strictObject({
      /** Mean of per-feature parity over the compared features, on each side. */
      corpus: z.number().min(0).max(1),
      holdout: z.number().min(0).max(1),
      /** corpus - holdout. */
      gap: z.number().min(-1).max(1),
      /** One-sided p-value of the gap: stratified by feature, cluster-robust. */
      p_value: z.number().min(0).max(1),
      /** Features compared. */
      features: Count,
    })
    .nullable(),
  no_gap: z.string().nullable(),
  /** p_value < holdout.alpha: the run failed on it. */
  significant: z.boolean(),
});

const CandidateSchema = z.strictObject({
  /** Its number, from 1, as in the report and the clusters. */
  candidate: z.number().int().positive(),
  command: z.string(),
  /** Mean of per-feature parity over `headline_features`; null when no feature qualifies. */
  headline: Parity,
  /** What `badge.svg` says for this candidate. */
  badge: z.string(),
  headline_features: z.array(z.string()),
  /** Counts over cases, each counted once; `parity` is match / scored. */
  raw: z.strictObject({ ...COUNTS, parity: Parity }),
  /** Per origin, under the headline's rules: `features` are the headline's features with a scored case of it. */
  origins: z.strictObject({ recorded: OriginSchema, imported: OriginSchema, generated: OriginSchema }),
  features: z.array(z.strictObject({ feature: z.string(), parity: Parity, ...COUNTS, self_description: z.boolean(), under_sampled: z.boolean(), in_headline: z.boolean() })),
  self_description: z.array(z.string()),
  under_sampled: z.array(z.string()),
  /** Features the CLI spec defines that no case carries. */
  untested: z.array(z.string()),
  /** The cases counted in `raw.timeout_recovered`: the re-run was compared, its first run having timed out where the reference finished. */
  timeout_recovered: z.array(CaseIdSchema),
  /** Coverage of each waiver, numbered from 1 in file order; `large` above the report's threshold. */
  waivers: z.array(z.strictObject({ waiver: z.number().int().positive(), cases: Count, share: z.number().min(0).max(1), large: z.boolean() })),
  /** Its fresh holdout; null when the run had none. */
  holdout: HoldoutSchema.nullable(),
});

/** `report.json`: one saved run of the whole corpus, machine-readable, for CI. */
export const ReportJsonSchema = z.strictObject({
  /** Of this format; a change that breaks readers bumps it. */
  version: z.literal(1),
  run_id: z.string(),
  /** When the run was saved, ISO 8601. */
  created: z.iso.datetime(),
  program_name: z.string(),
  reference: z.string(),
  sandbox: z.string(),
  /** Cases the run compared; the flaky-reference ones are left out (and listed in `flaky_reference`). */
  cases: Count,
  /** Cases left out because the reference itself varied in `port-anything baseline`, with the fields that varied. */
  flaky_reference: z.array(z.strictObject({ case: CaseIdSchema, fields: z.array(z.string()) })),
  compare: z.strictObject({ profile: z.string(), stderr: z.strictObject({ mode: z.string(), similarity: z.number().optional() }).optional() }),
  /** Features with fewer scored cases are left out of the headline. */
  min_cases_per_feature: Count,
  /** Per normalizer, the cases where it changed either side of a comparison. */
  normalizers: z.array(z.strictObject({ normalizer: z.string(), cases: Count })),
  /** As in `port-anything/waivers.yaml`, numbered from 1. */
  waivers: z.array(z.strictObject({ waiver: z.number().int().positive(), ...WaiverSchema.shape })),
  /** The fresh holdout: whether it ran (and why not), the new cases and the gap's significance level; null when the run didn't record it. */
  holdout: z
    .union([
      z.strictObject({ ran: z.literal(false), reason: z.string() }),
      z.strictObject({ ran: z.literal(true), cases: Count, in_corpus: Count, flaky_reference: Count, alpha: z.number().gt(0).lt(1), saved: Count }),
    ])
    .nullable(),
  candidates: z.array(CandidateSchema).min(1),
  /** Ranked, numbered through the run; `repro` is the case the report shows for it. */
  clusters: z.array(
    z.strictObject({
      cluster: z.number().int().positive(),
      candidate: z.number().int().positive(),
      /** The signature in words, as the report shows it. */
      description: z.string(),
      fields: z.array(z.enum(COMPARED_FIELDS)).min(1),
      shapes: z.array(z.strictObject({ field: z.enum(COMPARED_FIELDS), shape: z.enum(DIFF_SHAPES), detail: z.string().optional() })).min(1),
      features: z.array(z.strictObject({ feature: z.string(), cases: z.number().int().positive() })),
      size: z.number().int().positive(),
      weight: z.number().nonnegative(),
      cases: z.array(CaseIdSchema).min(1),
      repro: CaseIdSchema.nullable(),
      /** The repro's diverging fields as a line diff (reference -, candidate +, after normalizers); null when the run didn't keep them. */
      diff: z.array(z.string()).nullable(),
    }),
  ),
});

export type ReportJson = z.infer<typeof ReportJsonSchema>;

/** `ReportJsonSchema` as a JSON Schema (draft 2020-12), for readers outside TypeScript. */
export function reportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ReportJsonSchema) as Record<string, unknown>;
}

const counts = (c: CaseCounts) => ({
  cases: c.cases,
  scored: c.scored,
  match: c.match,
  diverge: c.diverge,
  waived: c.waived,
  flaky_reference: c.flakyReference,
  flaky_candidate: c.flakyCandidate,
  timeouts: c.timeouts,
  // Absent from scores saved before it was counted.
  timeout_recovered: c.timeoutRecovered ?? 0,
});

/**
 * The report as `report.json`: the same run and numbers as `report.html`, with keys in snake_case
 * like the run files. Repro contents stay in the HTML; a cluster names its repro case by ID.
 */
export function reportJson(input: ReportInput): ReportJson {
  const json: ReportJson = {
    version: 1,
    run_id: input.runId,
    created: input.created,
    program_name: input.programName,
    reference: input.reference,
    sandbox: input.sandbox,
    cases: input.cases,
    flaky_reference: (input.flakyReference ?? []).map((f) => ({ case: f.case, fields: [...f.fields] })),
    compare: input.compare,
    min_cases_per_feature: input.candidates[0]?.score.minCasesPerFeature ?? DEFAULT_MIN_CASES_PER_FEATURE,
    normalizers: input.normalizers.map((n) => ({ normalizer: n.normalizer, cases: n.cases })),
    waivers: input.waivers.map((w, i) => ({ waiver: i + 1, ...w })),
    holdout:
      input.holdout === undefined
        ? null
        : input.holdout.ran
          ? { ran: true, cases: input.holdout.cases, in_corpus: input.holdout.inCorpus, flaky_reference: input.holdout.flakyReference, alpha: input.holdout.alpha, saved: input.holdout.saved }
          : { ran: false, reason: input.holdout.reason },
    candidates: input.candidates.map((c, i) => {
      const s = c.score;
      return {
        candidate: i + 1,
        command: c.command,
        headline: s.headline,
        badge: badgeText(s),
        headline_features: s.headlineFeatures,
        raw: { ...counts(s.raw), parity: s.raw.parity },
        origins: s.origins,
        features: s.features.map((f) => ({
          feature: f.feature,
          parity: f.parity,
          ...counts(f),
          self_description: f.selfDescription,
          under_sampled: f.underSampled,
          in_headline: f.inHeadline,
        })),
        self_description: s.selfDescription,
        under_sampled: s.underSampled,
        untested: s.untested,
        timeout_recovered: [...c.timeoutRecovered],
        waivers: c.waivers.map((w) => ({ waiver: w.waiver, cases: w.cases, share: w.share, large: w.large })),
        holdout:
          c.holdout === undefined
            ? null
            : {
                match: c.holdout.match,
                diverge: c.holdout.diverge,
                parity: c.holdout.parity,
                ci95: c.holdout.ci95 === null ? null : [c.holdout.ci95[0], c.holdout.ci95[1]],
                features: c.holdout.features,
                gap: c.holdout.gap === null ? null : { corpus: c.holdout.gap.corpus, holdout: c.holdout.gap.holdout, gap: c.holdout.gap.gap, p_value: c.holdout.gap.pValue, features: c.holdout.gap.features },
                no_gap: c.holdout.noGap ?? null,
                significant: c.holdout.significant,
              },
      };
    }),
    clusters: input.clusters.map((k) => ({
      cluster: k.cluster,
      candidate: k.candidate,
      description: describeSignature(k.signature),
      fields: k.signature.fields,
      shapes: k.signature.shapes,
      features: k.features,
      size: k.size,
      weight: k.weight,
      cases: k.cases,
      repro: k.repro ?? null,
      diff: k.diff === undefined ? null : [...k.diff],
    })),
  };
  // Checked on the way out, so a report.json that doesn't match its schema is never written.
  return ReportJsonSchema.parse(json);
}

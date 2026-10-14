import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { caseFeatures, describeFeatures, describeSignature, type FeatureCount } from './cluster.js';
import { COMPARED_FIELDS, type ComparedField } from './compare.js';
import { ConfigError } from './config.js';
import { DIFF_SHAPES, type DiffShape, type FieldShape } from './diff-shape.js';

/** Where the waivers live, committed with the project. */
export const WAIVERS_FILE = 'port-anything/waivers.yaml';

/** Why a divergence is accepted: on purpose, the reference is wrong, or the platform differs. */
export const WAIVER_CATEGORIES = ['intentional', 'reference-bug', 'platform'] as const;

/** The fields a `regex` can test: the ones with text. */
const TEXT_FIELDS: readonly ComparedField[] = ['stdout', 'stderr'];

const PREDICATE_KEYS = ['feature', 'field', 'shape', 'regex'] as const;

const RegexSchema = z.string().superRefine((source, ctx) => {
  try {
    new RegExp(source, 'u');
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: `not a valid regular expression (${(e as Error).message})` });
  }
});

/**
 * Which divergences a waiver covers. Every key given must hold for a diverging field: the case
 * carries `feature` (an untagged case counts as `base`), the field is `field`, its diff shape is
 * `shape`, and `regex` finds a match in the reference's normalized output of the field.
 */
const PredicateSchema = z
  .strictObject({
    feature: z.string().min(1).optional(),
    field: z.enum(COMPARED_FIELDS).optional(),
    shape: z.enum(DIFF_SHAPES).optional(),
    regex: RegexSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if (PREDICATE_KEYS.every((k) => m[k] === undefined)) {
      ctx.addIssue({ code: 'custom', message: `needs at least one of ${PREDICATE_KEYS.join(', ')} (an empty predicate would waive everything)` });
    }
    if (m.regex !== undefined && m.field !== undefined && !TEXT_FIELDS.includes(m.field)) {
      ctx.addIssue({ code: 'custom', path: ['regex'], message: `only tests text fields: set field to stdout or stderr, or leave it out` });
    }
  });

export const WaiverSchema = z.strictObject({
  match: PredicateSchema,
  category: z.enum(WAIVER_CATEGORIES),
  reason: z.string().refine((s) => s.trim() !== '', 'must say why the divergence is accepted'),
});

export type Waiver = z.output<typeof WaiverSchema>;
export type WaiverPredicate = Waiver['match'];

const WaiversSchema = z.array(WaiverSchema, 'must be a list of waivers').nullable().transform((list) => list ?? []);

/** Validates parsed waivers, with every problem listed by its path (`0.match.regex`). */
export function parseWaivers(input: unknown, source = WAIVERS_FILE): Waiver[] {
  const result = WaiversSchema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(top level)'}: ${issue.message}`);
  throw new ConfigError([`${source} is not valid:`, ...problems].join('\n'));
}

/** Reads and validates the project's waivers; no file means none. Every failure is a `ConfigError`. */
export async function readWaiversFile(projectDir: string): Promise<Waiver[]> {
  let source: string;
  try {
    source = await readFile(join(projectDir, WAIVERS_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigError(`Cannot read ${WAIVERS_FILE}: ${(e as Error).message}`);
  }
  const doc = parseDocument(source, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ConfigError([`${WAIVERS_FILE} is not valid YAML:`, ...doc.errors.map((e) => `  ${e.message.replace(/\n/g, '\n  ')}`)].join('\n'));
  }
  return parseWaivers(doc.toJS(), WAIVERS_FILE);
}

/** One candidate's diverging case, as waivers see it. */
export interface WaivableDivergence {
  features: readonly string[];
  /** The shape of each diverging field, as `classifyDiff` gives them. */
  shapes: readonly FieldShape[];
  /** The reference's normalized stdout and stderr as text, for `regex`; a regex matches nothing without them. */
  reference?: Partial<Record<'stdout' | 'stderr', string>>;
}

export interface WaiverMatch {
  /** For each diverging field (in `shapes` order), the indexes of the waivers covering it. */
  fields: number[][];
  /** Every diverging field is covered: the case is waived. */
  waived: boolean;
  /** The shapes of the fields no waiver covers: what still diverges. */
  remaining: FieldShape[];
}

/**
 * Matches waivers against each diverging field of a case. A waiver covers a field, not a case: a
 * case is waived only when all its diverging fields are, so a waiver for one known difference
 * can't hide another bug in the same case. Only predicates on the case and the reference are
 * tested (a regex reads the reference's output), so the candidate can't steer its output into a
 * waiver; and nothing refers to clusters, so a waiver keeps matching when clustering changes.
 */
export function matchWaivers(d: WaivableDivergence, waivers: readonly Waiver[]): WaiverMatch {
  const features = caseFeatures(d.features);
  const fields = d.shapes.map((s) => waivers.flatMap((w, i) => (covers(w.match, s, features, d.reference) ? [i] : [])));
  return { fields, waived: fields.every((w) => w.length > 0), remaining: d.shapes.filter((_, i) => fields[i]!.length === 0) };
}

function covers(m: WaiverPredicate, s: FieldShape, features: readonly string[], reference: WaivableDivergence['reference']): boolean {
  if (m.feature !== undefined && !features.includes(m.feature)) return false;
  if (m.field !== undefined && m.field !== s.field) return false;
  if (m.shape !== undefined && m.shape !== s.shape) return false;
  if (m.regex !== undefined) {
    const text = s.field === 'stdout' || s.field === 'stderr' ? reference?.[s.field] : undefined;
    if (text === undefined || !new RegExp(m.regex, 'u').test(text)) return false;
  }
  return true;
}

/** A waiver covering more than this share of a candidate's cases is flagged in the report. */
export const LARGE_WAIVER_SHARE = 0.1;

export interface WaiverCoverage {
  /** Its position in the file, from 1. */
  waiver: number;
  /** The cases it covers at least one diverging field of. */
  cases: number;
  /** `cases` over all the cases of the run; 0 for an empty run. */
  share: number;
  /** Covers more than `LARGE_WAIVER_SHARE` of the cases. */
  large: boolean;
}

/** How many of one candidate's cases each waiver covers, from that candidate's matches. */
export function waiverCoverage(waivers: readonly Waiver[], matches: readonly WaiverMatch[], totalCases: number): WaiverCoverage[] {
  return waivers.map((_, i) => {
    const cases = matches.filter((m) => m.fields.some((w) => w.includes(i))).length;
    const share = totalCases === 0 ? 0 : cases / totalCases;
    return { waiver: i + 1, cases, share, large: share > LARGE_WAIVER_SHARE };
  });
}

/** A waiver on one line, such as `feature opt.debug, field stderr, regex /^sort: / (platform)`. */
export function describeWaiver(w: Waiver): string {
  const m = w.match;
  const keys = [
    m.feature === undefined ? [] : [`feature ${m.feature}`],
    m.field === undefined ? [] : [`field ${m.field}`],
    m.shape === undefined ? [] : [`shape ${m.shape}`],
    m.regex === undefined ? [] : [`regex /${m.regex}/`],
  ].flat();
  return `${keys.join(', ')} (${w.category})`;
}

/** What a suggestion reads from a cluster, live or saved with a run. */
export interface SuggestionSource {
  signature: { readonly fields: readonly ComparedField[]; readonly shapes: readonly { readonly field: ComparedField; readonly shape: DiffShape; readonly detail?: string | undefined }[] };
  features: readonly FeatureCount[];
}

/**
 * The predicates that waive a cluster's divergences: one per diverging field (each field is waived
 * on its own), with its shape but not the shape's detail, which is heuristic wording, and with the
 * cluster's feature when it has only one.
 */
export function suggestedPredicates(cluster: SuggestionSource): WaiverPredicate[] {
  const feature = cluster.features.length === 1 ? { feature: cluster.features[0]!.feature } : {};
  return cluster.signature.fields.map((field) => ({ ...feature, field, shape: fieldShape(cluster.signature, field)! }));
}

/**
 * A signature's shape for one of its fields. Exit, signal and timeout share the signature's single
 * `exit-code` entry (listed under the first of them), so a status field without its own entry is
 * `exit-code`; undefined for a field the signature doesn't have.
 */
function fieldShape(signature: SuggestionSource['signature'], field: ComparedField): DiffShape | undefined {
  if (!signature.fields.includes(field)) return undefined;
  return signature.shapes.find((s) => s.field === field)?.shape ?? 'exit-code';
}

/** Another cluster of the same run, as saved. */
export interface RunCluster extends SuggestionSource {
  /** Its number in the run. */
  cluster: number;
  size: number;
}

export interface ClusterReach {
  cluster: number;
  /** Its cases with a field the predicates cover: all of them, or those with the predicate's feature. */
  cases: number;
}

/**
 * The clusters of a run whose cases the predicates would also cover a field of. A predicate
 * without a regex covers a cluster's field when the signature has that field with that shape, in
 * the cases carrying its feature (all of them without one). With a regex it can't be told from the
 * saved run, so it counts as covering (an upper bound). Waivers apply per field, so a predicate
 * suggested for one cluster easily reaches others: an `exit-code` shape, for example, covers every
 * exit status difference.
 */
export function suggestionReach(predicates: readonly WaiverPredicate[], clusters: readonly RunCluster[]): ClusterReach[] {
  return clusters.flatMap((k) => {
    const cases = Math.max(
      0,
      ...predicates.map((m) => {
        const fields = m.field === undefined ? k.signature.fields : k.signature.fields.filter((f) => f === m.field);
        if (m.regex !== undefined && fields.every((f) => !TEXT_FIELDS.includes(f))) return 0;
        if (!fields.some((f) => m.shape === undefined || fieldShape(k.signature, f) === m.shape)) return 0;
        return m.feature === undefined ? k.size : (k.features.find((f) => f.feature === m.feature)?.cases ?? 0);
      }),
    );
    return cases === 0 ? [] : [{ cluster: k.cluster, cases }];
  });
}

/**
 * `waive --from-cluster`: the suggested waivers for a cluster as YAML to paste into the waivers
 * file. The reason is left empty, which the file doesn't accept, so it must be written in. With the
 * run's other clusters, it says which of them the waivers would also reach.
 */
export function suggestWaivers(cluster: SuggestionSource & { address: string }, others: readonly RunCluster[] = []): string {
  const lines = [
    `# Cluster ${cluster.address}: ${describeSignature(cluster.signature)} · features ${describeFeatures(cluster.features)}`,
    `# Paste into ${WAIVERS_FILE}, pick the category and write the reason.`,
  ];
  if (cluster.features.length > 1) lines.push('# Its cases have several features: add feature: <name> to waive only one of them.');
  const predicates = suggestedPredicates(cluster);
  const reach = suggestionReach(predicates, others);
  if (reach.length > 0) {
    const list = reach.map((r) => `${r.cluster} (${r.cases} case${r.cases === 1 ? '' : 's'})`).join(', ');
    lines.push(`# Warning: these would also waive fields of other clusters of this run: ${list}.`, '# Narrow them with feature: or regex: unless those are the same difference.');
  }
  for (const m of predicates) {
    const keys = PREDICATE_KEYS.flatMap((k) => (m[k] === undefined ? [] : [`${k}: ${flowScalar(m[k])}`]));
    lines.push(`- match: { ${keys.join(', ')} }`, `  category: intentional # ${WAIVER_CATEGORIES.join(' | ')}`, '  reason: ""');
  }
  return `${lines.join('\n')}\n`;
}

/** A plain YAML scalar when it reads back as the same string inside `{ }`, else double-quoted. */
function flowScalar(value: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(value) && !/^(true|false|null|~|[-+]?[\d.]+([eE][-+]?\d+)?)$/i.test(value) ? value : JSON.stringify(value);
}

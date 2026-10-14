import type { ComparedField } from './compare.js';
import type { FieldShape } from './diff-shape.js';

/** One diverging case of one candidate, as clustering sees it. */
export interface Divergence {
  caseId: string;
  /** The case's feature tags. */
  features: readonly string[];
  /** The shape of each diverging field, as `classifyDiff` gives them (in compared-field order). */
  shapes: readonly FieldShape[];
}

/** What every case of a cluster shares. */
export interface ClusterSignature {
  /** The diverging fields, in compared-field order. */
  fields: ComparedField[];
  /**
   * The shape of each diverging field. Exit, signal and timeout describe one outcome, so they
   * share a single `exit-code` entry (the first of them that diverges).
   */
  shapes: FieldShape[];
  /** The case's feature tags, sorted. */
  features: string[];
}

export interface Cluster {
  signature: ClusterSignature;
  /** The signature as one string; equal exactly when the signatures are. */
  key: string;
  /** Case IDs, in the order the divergences were given. */
  cases: string[];
  /**
   * Size × the mean feature weight of its cases (see `featureWeights`): how much of the per-feature
   * headline the cluster holds down, so a big cluster in a well-sampled feature can rank below a
   * smaller one that is most of a thin feature.
   */
  weight: number;
}

/** The feature a case without feature tags counts toward. */
export const UNTAGGED_FEATURE = 'base';

const STATUS_FIELDS: readonly ComparedField[] = ['exit', 'signal', 'timeout'];

export function clusterSignature(d: Divergence): ClusterSignature {
  const shapes: FieldShape[] = [];
  for (const s of d.shapes) {
    if (STATUS_FIELDS.includes(s.field) && shapes.some((t) => STATUS_FIELDS.includes(t.field))) continue;
    shapes.push(s.detail === undefined ? { field: s.field, shape: s.shape } : { field: s.field, shape: s.shape, detail: s.detail });
  }
  return { fields: d.shapes.map((s) => s.field), shapes, features: [...new Set(d.features)].sort() };
}

export function signatureKey(s: ClusterSignature): string {
  return JSON.stringify([s.fields, s.shapes.map((x) => [x.field, x.shape, x.detail ?? null]), s.features]);
}

/**
 * A feature's weight: 1 over the number of cases tagged with it, so that each feature weighs the
 * same in total, as in the per-feature headline. A case counts toward each of its features, and a
 * case without tags toward `base`.
 */
export function featureWeights(cases: readonly { features: readonly string[] }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of cases) for (const f of caseFeatures(c.features)) counts.set(f, (counts.get(f) ?? 0) + 1);
  return new Map([...counts].map(([f, n]) => [f, 1 / n]));
}

const caseFeatures = (features: readonly string[]) => (features.length === 0 ? [UNTAGGED_FEATURE] : [...new Set(features)]);

/**
 * Groups one candidate's divergences by signature (diverging fields + diff shapes + features) and
 * ranks the clusters by weight, then size, then key, so the order is the same on every run of the
 * same results. `weights` come from `featureWeights` over all the cases of the run; a feature it
 * lacks weighs 0.
 */
export function clusterDivergences(divergences: readonly Divergence[], weights: ReadonlyMap<string, number>): Cluster[] {
  const byKey = new Map<string, Cluster>();
  for (const d of divergences) {
    const signature = clusterSignature(d);
    const key = signatureKey(signature);
    let cluster = byKey.get(key);
    if (cluster === undefined) byKey.set(key, (cluster = { signature, key, cases: [], weight: 0 }));
    cluster.cases.push(d.caseId);
    for (const f of caseFeatures(d.features)) cluster.weight += weights.get(f) ?? 0;
  }
  // Weights are sums of fractions, so two equal ones may differ in the last bits.
  const heavier = (a: Cluster, b: Cluster) => (Math.abs(b.weight - a.weight) > 1e-9 ? b.weight - a.weight : 0);
  return [...byKey.values()].sort((a, b) => heavier(a, b) || b.cases.length - a.cases.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A one-line description of a signature, such as `stdout number-value · features opt.l`. */
export function describeSignature(s: ClusterSignature): string {
  const shapes = s.shapes.map((x) => (x.shape === 'exit-code' ? `${x.field} ${x.detail}` : `${x.field} ${x.shape}${x.detail === undefined ? '' : ` (${x.detail})`}`));
  return [shapes.join(', '), ...(s.features.length === 0 ? [] : [`features ${s.features.join(', ')}`])].join(' · ');
}

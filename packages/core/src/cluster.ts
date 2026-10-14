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
}

/** How many of a cluster's cases carry a feature. */
export interface FeatureCount {
  feature: string;
  cases: number;
}

export interface Cluster {
  signature: ClusterSignature;
  /** The signature as one string; equal exactly when the signatures are. */
  key: string;
  /** Case IDs, in the order the divergences were given. */
  cases: string[];
  /**
   * The features of its cases, most cases first, then by name; a case counts toward each of its
   * features, and a case without tags toward `base`. Not part of the signature.
   */
  features: FeatureCount[];
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
  return { fields: d.shapes.map((s) => s.field), shapes };
}

export function signatureKey(s: {
  readonly fields: readonly ComparedField[];
  readonly shapes: readonly { readonly field: ComparedField; readonly shape: FieldShape['shape']; readonly detail?: string | undefined }[];
}): string {
  return JSON.stringify([s.fields, s.shapes.map((x) => [x.field, x.shape, x.detail ?? null])]);
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
 * Groups one candidate's divergences by signature (diverging fields + diff shapes; the cases'
 * features are counted per cluster, not part of the key, or generated cases with their own flag
 * combinations would each get a cluster) and ranks the clusters by weight, then size, then key, so
 * the order is the same on every run of the same results. `weights` come from `featureWeights`
 * over all the cases of the run; a feature it lacks weighs 0.
 */
export function clusterDivergences(divergences: readonly Divergence[], weights: ReadonlyMap<string, number>): Cluster[] {
  const byKey = new Map<string, { cluster: Cluster; counts: Map<string, number> }>();
  for (const d of divergences) {
    const signature = clusterSignature(d);
    const key = signatureKey(signature);
    let entry = byKey.get(key);
    if (entry === undefined) byKey.set(key, (entry = { cluster: { signature, key, cases: [], features: [], weight: 0 }, counts: new Map() }));
    entry.cluster.cases.push(d.caseId);
    for (const f of caseFeatures(d.features)) {
      entry.cluster.weight += weights.get(f) ?? 0;
      entry.counts.set(f, (entry.counts.get(f) ?? 0) + 1);
    }
  }
  const clusters = [...byKey.values()].map(({ cluster, counts }) => {
    cluster.features = [...counts].map(([feature, cases]) => ({ feature, cases })).sort((a, b) => b.cases - a.cases || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
    return cluster;
  });
  // Weights are sums of fractions, so two equal ones may differ in the last bits.
  const heavier = (a: Cluster, b: Cluster) => (Math.abs(b.weight - a.weight) > 1e-9 ? b.weight - a.weight : 0);
  return clusters.sort((a, b) => heavier(a, b) || b.cases.length - a.cases.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A one-line description of a signature, such as `exit 2 vs 1, stdout empty (candidate empty)`. */
export function describeSignature(s: {
  readonly shapes: readonly { readonly field: ComparedField; readonly shape: FieldShape['shape']; readonly detail?: string | undefined }[];
}): string {
  return s.shapes.map((x) => (x.shape === 'exit-code' ? `${x.field} ${x.detail}` : `${x.field} ${x.shape}${x.detail === undefined ? '' : ` (${x.detail})`}`)).join(', ');
}

/** A cluster's features with their case counts, such as `opt.l (2), base (1)`. */
export function describeFeatures(features: readonly FeatureCount[]): string {
  return features.map((f) => `${f.feature} (${f.cases})`).join(', ');
}

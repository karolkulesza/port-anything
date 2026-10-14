import type { BlobStore } from './blob-store.js';
import { caseFeatures } from './cluster.js';
import { ConfigError } from './config.js';
import { storedCaseSize } from './minimize.js';
import { canonicalCase, type CanonicalCase } from './model.js';
import { loadRepro, type RunRecord } from './runs.js';

/** Cases per feature in a smoke subset, unless told otherwise. */
export const SMOKE_CASES_PER_FEATURE = 5;

/** Cases that didn't diverge in the latest run added to a smoke subset to catch regressions, unless told otherwise. */
export const SMOKE_PASSING_CASES = 50;

export interface SmokeSubsetOptions {
  /** The whole corpus. */
  corpus: readonly CanonicalCase[];
  /** One case per open cluster, as `openClusterCases` gives them; they need not be in the corpus. */
  clusterCases: readonly CanonicalCase[];
  /** The cases that diverged in the latest run; the passing sample leaves them out. */
  diverged: ReadonlySet<string>;
  /** Defaults to `SMOKE_CASES_PER_FEATURE`. */
  perFeature?: number;
  /** Defaults to `SMOKE_PASSING_CASES`. */
  passing?: number;
}

export interface SmokeSubset {
  /** The cluster cases first, then the others in corpus order. */
  cases: CanonicalCase[];
  /** How many cases each part added; a case picked by an earlier part counts there only. */
  clusters: number;
  perFeature: number;
  passing: number;
}

/**
 * The smoke subset of a corpus, for the inner loop (a few seconds instead of a full run): a case
 * for every open cluster, then `perFeature` cases of each feature (`base` for cases without
 * tags), then `passing` cases that didn't diverge in the latest run. The samples are the first
 * cases by case ID, which is a hash: random with respect to their content, but the same on every
 * run of the same corpus, so two smoke runs compare the same cases.
 */
export function smokeSubset(options: SmokeSubsetOptions): SmokeSubset {
  const perFeature = options.perFeature ?? SMOKE_CASES_PER_FEATURE;
  const passing = options.passing ?? SMOKE_PASSING_CASES;
  const picked = new Set<string>();
  const clusterCases: CanonicalCase[] = [];
  for (const c of options.clusterCases) {
    if (picked.has(c.id)) continue;
    picked.add(c.id);
    clusterCases.push(c);
  }

  const sorted = [...options.corpus].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = new Map<string, number>();
  let byFeature = 0;
  for (const c of sorted) {
    const features = caseFeatures(c.features);
    if (!features.some((f) => (taken.get(f) ?? 0) < perFeature)) continue;
    for (const f of features) taken.set(f, (taken.get(f) ?? 0) + 1);
    if (picked.has(c.id)) continue;
    picked.add(c.id);
    byFeature++;
  }
  let sampled = 0;
  for (const c of sorted) {
    if (sampled >= passing) break;
    if (picked.has(c.id) || options.diverged.has(c.id)) continue;
    picked.add(c.id);
    sampled++;
  }

  const listed = new Set(clusterCases.map((c) => c.id));
  const rest: CanonicalCase[] = [];
  for (const c of options.corpus) {
    if (!picked.has(c.id) || listed.has(c.id)) continue;
    listed.add(c.id);
    rest.push(c);
  }
  return { cases: [...clusterCases, ...rest], clusters: clusterCases.length, perFeature: byFeature, passing: sampled };
}

/**
 * One case per cluster of a saved run, standing for it in a smoke subset: its saved repro (see
 * `saveRepro`) when it has one, else its smallest case (by `caseSize`) still in the corpus. A
 * cluster with neither is left out. A repro's stdin and fixtures are put in `store`, and it takes
 * its source case's features and origin (normalizers may be scoped to features), or none and
 * `generated` when the corpus no longer has the source. A damaged repro is a `ConfigError`.
 */
export async function openClusterCases(projectDir: string, run: RunRecord, corpus: readonly CanonicalCase[], store: BlobStore): Promise<CanonicalCase[]> {
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const out: CanonicalCase[] = [];
  for (const cluster of run.clusters) {
    const repro = await loadRepro(projectDir, run.run_id, cluster.cluster);
    if (repro !== undefined) {
      const source = byId.get(repro.source);
      const { id, argv, stdin, env, fixtures } = repro.case;
      const refs: Record<string, string> = {};
      for (const [path, content] of Object.entries(fixtures)) refs[path] = await store.put(bytesOf(content));
      let c: CanonicalCase;
      try {
        c = canonicalCase({
          id,
          argv,
          stdin: stdin === null ? null : await store.put(bytesOf(stdin)),
          env,
          fixtures: refs,
          features: source?.features ?? [],
          origin: source?.origin ?? 'generated',
        });
      } catch (e) {
        throw new ConfigError(`The repro of cluster ${run.run_id}/${cluster.cluster} is damaged: ${(e as Error).message}`);
      }
      out.push(c);
      continue;
    }
    let smallest: { c: CanonicalCase; size: number } | undefined;
    for (const id of cluster.cases) {
      const c = byId.get(id);
      if (c === undefined) continue;
      const size = await storedCaseSize(c, store);
      if (smallest === undefined || size < smallest.size) smallest = { c, size };
    }
    if (smallest !== undefined) out.push(smallest.c);
  }
  return out;
}

const bytesOf = (content: string | { base64: string }) => (typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));

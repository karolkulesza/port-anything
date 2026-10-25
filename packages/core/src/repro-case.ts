import type { BlobStore } from './blob-store.js';
import type { CanonicalCase } from './model.js';

/**
 * Picks a cluster's repro: the smallest of its cases the corpus still has (argv, environment,
 * stdin and files, in bytes), the first of them on a tie; else its first case. `run` keeps the
 * diverging outputs of this case, and `report` shows it. Sizes are remembered across calls.
 */
export function reproPicker(store: BlobStore): (caseIds: readonly string[], byId: ReadonlyMap<string, CanonicalCase>) => Promise<string> {
  const sizes = new Map<string, number>();
  const size = async (c: CanonicalCase) => {
    let n = sizes.get(c.id);
    if (n === undefined) {
      n = c.argv.reduce((sum, a) => sum + Buffer.byteLength(a) + 1, 0) + Object.entries(c.env).reduce((sum, [k, v]) => sum + Buffer.byteLength(k) + Buffer.byteLength(v) + 1, 0);
      for (const ref of [...(c.stdin === null ? [] : [c.stdin]), ...Object.values(c.fixtures)]) n += (await store.get(ref)).length;
      sizes.set(c.id, n);
    }
    return n;
  };
  return async (caseIds, byId) => {
    let best: { id: string; size: number } | undefined;
    for (const id of caseIds) {
      const c = byId.get(id);
      if (c === undefined) continue;
      const n = await size(c);
      if (best === undefined || n < best.size) best = { id, size: n };
    }
    return best?.id ?? caseIds[0]!;
  };
}

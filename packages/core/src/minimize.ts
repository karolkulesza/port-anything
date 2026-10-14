import type { BlobStore } from './blob-store.js';
import { canonicalCase, type CanonicalCase } from './model.js';

/** Runs a minimization may make per cluster, unless told otherwise. */
export const DEFAULT_MINIMIZE_RUNS = 200;

/**
 * Delta debugging (ddmin, Zeller & Hildebrandt 2002): a 1-minimal sublist of `items` for which
 * `test` still returns true, in the original order. The caller knows the whole list passes, so it
 * is never tested; the empty list is tried first. An error thrown by `test` stops the search and
 * propagates (the minimizer uses that to stop at its run budget).
 */
export async function ddmin<T>(items: readonly T[], test: (subset: T[]) => Promise<boolean>): Promise<T[]> {
  let current = [...items];
  if (current.length === 0) return current;
  if (await test([])) return [];
  let n = 2;
  while (current.length >= 2) {
    const chunks = split(current, n);
    let reduced = false;
    for (const chunk of chunks) {
      if (await test(chunk)) {
        current = chunk;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced && chunks.length > 2) {
      for (const i of chunks.keys()) {
        const complement = chunks.flatMap((c, j) => (j === i ? [] : c));
        if (await test(complement)) {
          current = complement;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return current;
}

/** `items` in `n` contiguous chunks, as even as possible, the longer ones first. */
function split<T>(items: readonly T[], n: number): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + Math.ceil((items.length - start) / (n - i));
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Whether a case still shows what is being minimized (for a cluster: diverges with its signature). */
export type CaseTest = (c: CanonicalCase) => Promise<boolean>;

export interface MinimizeOptions {
  /** Holds the case's stdin and fixtures; the smaller ones tried are added to it. */
  store: BlobStore;
  /**
   * Most calls of the test, the check of the source case included. A case asked about again (the
   * same ID) is answered from memory and doesn't count. Defaults to `DEFAULT_MINIMIZE_RUNS`.
   */
  maxRuns?: number;
}

export interface Minimized {
  /**
   * The smallest case found that passes the test: the source when it doesn't. Its environment,
   * features and origin are the source's (normalizers may be scoped to features, so the smaller
   * cases are compared the same way).
   */
  case: CanonicalCase;
  /** Whether the source case passed the test; when not, nothing was minimized. */
  reproduced: boolean;
  /** Calls of the test made. */
  runs: number;
  /** The run budget ran out first, so the case may not be 1-minimal. */
  exhausted: boolean;
}

/** The contents a minimization works on. */
interface Parts {
  argv: string[];
  stdin: Buffer | null;
  fixtures: [path: string, content: Buffer][];
}

class BudgetSpent extends Error {}

/**
 * Shrinks a case that passes `test` to a smaller one that still passes: drops argv tokens, then
 * fixture files, then shrinks each fixture by lines and then bytes, then stdin (none at all, then
 * lines, then bytes), and repeats until a whole round changes nothing or the run budget is spent.
 * The environment is kept as it is.
 */
export async function minimizeCase(source: CanonicalCase, test: CaseTest, options: MinimizeOptions): Promise<Minimized> {
  const { store } = options;
  const maxRuns = options.maxRuns ?? DEFAULT_MINIMIZE_RUNS;
  if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error(`The run budget must be a positive integer, got ${maxRuns}.`);
  const answers = new Map<string, boolean>();
  let runs = 0;
  const ask = async (c: CanonicalCase): Promise<boolean> => {
    const known = answers.get(c.id);
    if (known !== undefined) return known;
    if (runs >= maxRuns) throw new BudgetSpent();
    runs++;
    const passed = await test(c);
    answers.set(c.id, passed);
    return passed;
  };

  const toCase = async (p: Parts): Promise<CanonicalCase> => {
    const fixtures: Record<string, string> = {};
    for (const [path, content] of p.fixtures) fixtures[path] = await store.put(content);
    const stdin = p.stdin === null ? null : await store.put(p.stdin);
    return canonicalCase({ argv: p.argv, stdin, env: source.env, fixtures, features: source.features, origin: source.origin });
  };

  if (!(await ask(source))) return { case: source, reproduced: false, runs, exhausted: false };
  let best = source;
  let parts: Parts = {
    argv: [...source.argv],
    stdin: source.stdin === null ? null : await store.get(source.stdin),
    fixtures: await Promise.all(Object.entries(source.fixtures).map(async ([path, ref]) => [path, await store.get(ref)] as [string, Buffer])),
  };
  /** Tries a smaller version of the parts; keeps it when it passes. */
  const attempt = async (next: Parts): Promise<boolean> => {
    const c = await toCase(next);
    if (!(await ask(c))) return false;
    parts = next;
    best = c;
    return true;
  };
  /** ddmin over one list of the parts, rebuilt into parts by `rebuild`. */
  const reduce = async <T>(items: T[], rebuild: (kept: T[]) => Parts) => {
    await ddmin(items, (kept) => attempt(rebuild(kept)));
  };

  try {
    for (let changed = true; changed; ) {
      const before = best.id;
      await reduce(parts.argv, (argv) => ({ ...parts, argv }));
      await reduce(parts.fixtures, (fixtures) => ({ ...parts, fixtures }));
      for (const path of parts.fixtures.map(([p]) => p)) {
        const content = () => parts.fixtures.find(([p]) => p === path)![1];
        const withContent = (bytes: Buffer): Parts => ({ ...parts, fixtures: parts.fixtures.map(([p, c]) => [p, p === path ? bytes : c]) });
        await reduce(lines(content()), (kept) => withContent(Buffer.concat(kept)));
        await reduce([...content()], (kept) => withContent(Buffer.from(kept)));
      }
      if (parts.stdin !== null && !(await attempt({ ...parts, stdin: null }))) {
        await reduce(lines(parts.stdin!), (kept) => ({ ...parts, stdin: Buffer.concat(kept) }));
        await reduce([...parts.stdin!], (kept) => ({ ...parts, stdin: Buffer.from(kept) }));
      }
      changed = best.id !== before;
    }
  } catch (e) {
    if (e instanceof BudgetSpent) return { case: best, reproduced: true, runs, exhausted: true };
    throw e;
  }
  return { case: best, reproduced: true, runs, exhausted: false };
}

/** The lines of some bytes, each with its newline; the last one may have none. */
function lines(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, start)) {
    out.push(bytes.subarray(start, i + 1));
    start = i + 1;
  }
  if (start < bytes.length) out.push(bytes.subarray(start));
  return out;
}

/** The size of a case's input, in bytes: argv tokens, stdin, fixture paths and contents (text as UTF-8). */
export function caseSize(c: {
  readonly argv: readonly string[];
  readonly stdin: string | Uint8Array | null;
  readonly fixtures: Readonly<Record<string, string | Uint8Array>>;
}): number {
  const bytes = (x: string | Uint8Array) => (typeof x === 'string' ? Buffer.byteLength(x) : x.length);
  let size = c.argv.reduce((n, a) => n + bytes(a), 0) + (c.stdin === null ? 0 : bytes(c.stdin));
  for (const [path, content] of Object.entries(c.fixtures)) size += bytes(path) + bytes(content);
  return size;
}

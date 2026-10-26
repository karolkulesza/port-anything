import { generateArgvCases, isSafeArgvToken, type ArgvStrategy, type GenerateArgvOptions } from './argv-generator.js';
import { blobRef } from './blob-store.js';
import { mutateBytes } from './byte-mutation.js';
import { canonicalJson } from './canonical-json.js';
import { destructiveCommand } from './destructive.js';
import { specFeatures, type CliSpec } from './cli-spec.js';
import { canonicalCase, type CanonicalCase, type Observation } from './model.js';
import { baseGenerator, createRng, type Rng } from './rng.js';
import { buildTokenDictionary, type TokenDictionary } from './token-dictionary.js';
import { mutateTokens } from './token-mutation.js';

// Like the argv generator, everything here that decides which cases a corpus holds (orders,
// draws, sample sizes) is part of generator v1, and the mutation of committed cases is part of
// v2. Changes go into a new generator version.

/** Most generated cases a corpus holds (`corpus.budget`, `--budget`). */
export const DEFAULT_BUDGET = 10_000;
/** Largest share of a feature's cases that may be error exits (`corpus.error_path_cap`). */
export const DEFAULT_ERROR_PATH_CAP = 0.3;
/** Cases the generator tops every feature up to (`corpus.min_cases_per_feature`). */
export const DEFAULT_MIN_CASES_PER_FEATURE = 20;
/** Cases kept per reference behavior and feature set; further ones are duplicates. */
export const DEDUP_SAMPLE = 3;

/** Cases sent to the reference at once. */
const BATCH = 32;
/** Mutants of a feature rejected in a row before the generator stops trying that feature. */
const STALL_LIMIT = 25;
/** Most byte mutations stacked on one input. */
const MAX_STACKED = 3;
/** The group every case counts in, so untagged cases are capped too. */
const ALL = '*';

/**
 * How a corpus case came about: an argv strategy, byte mutation of a case's input, or (generator
 * v2) token mutation of an argument of a committed case.
 */
export type CorpusStrategy = ArgvStrategy | 'mutation' | 'token-mutation';

/** True for a case derived from another one rather than built from the CLI spec. */
export function isMutantStrategy(strategy: CorpusStrategy): boolean {
  return strategy === 'mutation' || strategy === 'token-mutation';
}

export interface CorpusCase {
  case: CanonicalCase;
  strategy: CorpusStrategy;
  /** The reference's behavior on the case, as the filters saw it. */
  observation: Observation;
}

/** Runs the reference once on each case; observations in case order. `blobs` holds their stdin and fixtures. */
export type ObserveReference = (cases: readonly CanonicalCase[], blobs: ReadonlyMap<string, Uint8Array>) => Promise<readonly Observation[]>;

export interface GenerateCorpusOptions extends GenerateArgvOptions {
  observe: ObserveReference;
  /** Seed fixtures (`port-anything/seeds/`): mutated in place of a case's stdin or fixture. */
  seeds?: readonly Uint8Array[];
  /**
   * The project's committed cases and the content of their stdin and fixtures. From generator v2
   * on they are mutation parents too: an argument that isn't a flag or a fixture's path (a
   * program, a query, an expression) gets one whole-token mutation, or an input a byte mutation.
   * Generator v1 ignores them.
   */
  committed?: { cases: readonly CanonicalCase[]; blobs: ReadonlyMap<string, Uint8Array> };
  budget?: number;
  /** Wall-clock cap in milliseconds (`--time`); generation stops between batches once it's reached. */
  timeMs?: number;
  errorPathCap?: number;
  minCasesPerFeature?: number;
  /** Clock in milliseconds; for tests. */
  now?: () => number;
}

export interface CorpusStats {
  /** Cases the reference ran. */
  observed: number;
  dropped: {
    /** Same reference behavior and features as `DEDUP_SAMPLE` kept cases. */
    duplicate: number;
    /** Error exits over the error-path cap. */
    errorCap: number;
    /** Observed after the budget was full. */
    budget: number;
  };
  /** Why generation ended: every source used up, the budget full, or the time cap reached. */
  stop: 'exhausted' | 'budget' | 'time';
  /** Features below `minCasesPerFeature` (self-description features aside), with their case counts. */
  underSampled: { feature: string; cases: number }[];
  /**
   * The reference's most frequent error answer over every case it ran, kept or not, and how many
   * times it gave it (the first one to get there on a tie); absent when it never failed. A share of
   * `observed` close to 1 means most generated cases only reach that error (often the usage text of
   * a spec whose forms the program rejects).
   */
  commonestError?: CommonestError;
}

/** An error answer of the reference: what it printed and how it ended (the content of the outputs is in the blob store). */
export type CommonestError = Pick<Observation, 'exit' | 'signal' | 'timeout' | 'stdout' | 'stderr'> & { answers: number };

export interface GeneratedCorpus {
  /** In the order they were kept. */
  cases: CorpusCase[];
  /** Contents of every stdin and fixture blob the cases reference, by blob ref. */
  blobs: Map<string, Uint8Array>;
  /** Destructive subcommands left out (see `generateArgvCases`). */
  skipped: string[];
  stats: CorpusStats;
}

/**
 * Builds a generated corpus: the argv cases of `generateArgvCases`, then byte mutants of their
 * stdin and fixtures (or of the seed fixtures in their place) that top every feature up to
 * `minCasesPerFeature` and then fill the corpus up to the budget. Every case runs on the
 * reference, and the filters decide what stays:
 * - dedup by observation: at most `DEDUP_SAMPLE` cases per reference behavior and feature set;
 * - error-path cap: in every feature (and over the whole corpus), at most `errorPathCap` of the
 *   cases are error exits; error cases wait until enough other cases make room for them;
 * - budget: at most `budget` cases; time cap: no new batch starts after `timeMs`.
 *
 * From generator v2 on, the committed cases are mutation parents next to the argv cases (see
 * `mutateCommitted`): the way to a corpus for a program whose input is code, such as an awk
 * program or an SQL script, which argv generation from a CLI spec can't write.
 *
 * Argv cases are taken round-robin over features, so a small budget is spread over all of them.
 * The result depends only on the spec, the seeds, the committed cases (v2), the seed, the
 * generator version and the reference's behavior (unless the time cap cuts it short).
 */
export async function generateCorpus(spec: CliSpec, options: GenerateCorpusOptions): Promise<GeneratedCorpus> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const cap = options.errorPathCap ?? DEFAULT_ERROR_PATH_CAP;
  const minCases = options.minCasesPerFeature ?? DEFAULT_MIN_CASES_PER_FEATURE;
  if (!Number.isInteger(budget) || budget < 0) throw new RangeError('budget must be a whole number of cases');
  if (!(cap >= 0 && cap <= 1)) throw new RangeError('errorPathCap must be between 0 and 1');
  if (!Number.isInteger(minCases) || minCases < 0) throw new RangeError('minCasesPerFeature must be a whole number of cases');
  if (options.timeMs !== undefined && !(options.timeMs > 0)) throw new RangeError('timeMs must be positive');
  const now = options.now ?? Date.now;
  const started = now();
  const timeUp = () => options.timeMs !== undefined && now() - started >= options.timeMs;

  const argv = generateArgvCases(spec, options);
  const blobs = argv.blobs;
  const selector = new Selector(budget, cap);
  let observed = 0;
  const errors = new ErrorTally();
  let stop: CorpusStats['stop'] = 'exhausted';

  const observe = async (batch: { case: CanonicalCase; strategy: CorpusStrategy }[]): Promise<CorpusCase[]> => {
    const observations = await options.observe(
      batch.map((b) => b.case),
      blobs,
    );
    if (observations.length !== batch.length) throw new Error(`observe returned ${observations.length} observations for ${batch.length} cases`);
    observed += batch.length;
    for (const o of observations) errors.add(o);
    return batch.map((b, i) => ({ case: b.case, strategy: b.strategy, observation: observations[i]! }));
  };
  const checkStop = (): boolean => {
    if (selector.full) stop = 'budget';
    else if (timeUp()) stop = 'time';
    else return false;
    return true;
  };

  // Argv cases, round-robin over features.
  const ordered = roundRobin(argv.cases);
  const parents: CorpusCase[] = [];
  for (let at = 0; at < ordered.length; at += BATCH) {
    if (checkStop()) break;
    for (const c of await observe(ordered.slice(at, at + BATCH))) {
      parents.push(c);
      selector.offer(c);
    }
    selector.retryDeferred();
  }

  // Generator v2: the committed cases are mutation parents too, under their features (`base` for
  // an untagged one, as in scoring). In ID order, so moving a case to another line or file
  // doesn't change the corpus (the cache key doesn't see their order either).
  const committed = options.generator === 'v1' ? [] : canonicalOrder(options.committed?.cases ?? []);
  const committedParents = new Map<string, CanonicalCase[]>();
  for (const c of committed) {
    for (const f of tagsOf(c)) {
      if (!committedParents.has(f)) committedParents.set(f, []);
      committedParents.get(f)!.push(c);
    }
  }
  for (const [ref, bytes] of committed.length > 0 ? options.committed!.blobs : []) if (!blobs.has(ref)) blobs.set(ref, bytes);
  const code = committed.flatMap((c) => codeArguments(c).map((i) => c.argv[i]!));
  const tokens = { dictionary: buildTokenDictionary({ seeds: code }), donors: code };

  // Mutants: features under the minimum first, then all of them, until the budget is full.
  const selfDescription = new Set(specFeatures(spec).filter((f) => f.selfDescription).map((f) => f.name));
  const targets = [...new Set([...parents.flatMap((p) => p.case.features), ...committedParents.keys()])].filter((f) => !selfDescription.has(f)).sort();
  const rng = createRng(`${options.seed}\0byte-mutation`, baseGenerator(options.generator));
  const seen = new Set([...parents.map((p) => p.case.id), ...committed.map((c) => c.id)]);
  const stalled = new Map<string, number>(targets.map((f) => [f, 0]));
  let cursor = 0;
  while (stop === 'exhausted' && !checkStop()) {
    const active = targets.filter((f) => stalled.get(f)! < STALL_LIMIT);
    if (active.length === 0) break;
    const under = active.filter((f) => selector.count(f) < minCases);
    const pool = under.length > 0 ? under : active;
    const batch: { case: CanonicalCase; strategy: CorpusStrategy; feature: string }[] = [];
    const keptParents = new Map<string, CorpusCase[]>();
    for (const c of selector.accepted) {
      if (isMutantStrategy(c.strategy)) continue;
      for (const f of c.case.features) {
        if (!keptParents.has(f)) keptParents.set(f, []);
        keptParents.get(f)!.push(c);
      }
    }
    const room = Math.min(BATCH, budget - selector.size);
    for (let tries = 0; batch.length < room && tries < 2 * room; tries++) {
      const feature = pool[cursor++ % pool.length]!;
      const generated = (keptParents.get(feature) ?? parents.filter((c) => c.case.features.includes(feature))).map((c) => c.case);
      const fromCommitted = committedParents.get(feature);
      const parent = rng.pick(fromCommitted === undefined ? generated : [...generated, ...fromCommitted]);
      const mutant =
        fromCommitted?.includes(parent) === true
          ? mutateCommitted(parent, rng, blobs, options.seeds ?? [], { ...tokens, program: spec.program, iKnow: options.iKnow === true })
          : { case: mutateCase(parent, rng, blobs, options.seeds ?? []), strategy: 'mutation' as const };
      if (seen.has(mutant.case.id)) {
        stalled.set(feature, stalled.get(feature)! + 1);
        continue;
      }
      seen.add(mutant.case.id);
      batch.push({ ...mutant, feature });
    }
    if (batch.length === 0) continue;
    const observed = await observe(batch);
    observed.forEach((c, i) => {
      const feature = batch[i]!.feature;
      stalled.set(feature, selector.offer(c) ? 0 : stalled.get(feature)! + 1);
    });
    selector.retryDeferred();
  }

  const underSampled = targets.map((feature) => ({ feature, cases: selector.count(feature) })).filter((f) => f.cases < minCases);
  // Rejected mutants' inputs were stored too; keep only what the kept cases use.
  const used = new Map<string, Uint8Array>();
  for (const { case: c } of selector.accepted) {
    for (const ref of [c.stdin, ...Object.values(c.fixtures)]) if (ref !== null) used.set(ref, blobs.get(ref)!);
  }
  return {
    cases: selector.accepted,
    blobs: used,
    skipped: argv.skipped,
    stats: { observed, dropped: selector.dropped(), stop, underSampled, ...errors.commonest() },
  };
}

/** True for a reference behavior that is an error path: a non-zero exit, a signal or a timeout. */
export function isErrorObservation(o: Observation): boolean {
  return o.exit !== 0 || o.timeout;
}

/** Counts the reference's error answers by what it printed and how it ended. */
class ErrorTally {
  private readonly counts = new Map<string, number>();
  private top: CommonestError | undefined;

  add(o: Observation): void {
    if (!isErrorObservation(o)) return;
    const answer = { exit: o.exit, signal: o.signal, timeout: o.timeout, stdout: o.stdout, stderr: o.stderr };
    const key = canonicalJson(answer);
    const answers = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, answers);
    if (answers > (this.top?.answers ?? 0)) this.top = { ...answer, answers };
  }

  /** `{ commonestError }`, or nothing when the reference never failed. */
  commonest(): { commonestError?: CommonestError } {
    return this.top === undefined ? {} : { commonestError: this.top };
  }
}

const behaviorKeys = new WeakMap<CorpusCase, string>();

/** What makes two reference behaviors the same for dedup: everything but timings and run counts. */
function behaviorKey(c: CorpusCase): string {
  const cached = behaviorKeys.get(c);
  if (cached !== undefined) return cached;
  const o = c.observation;
  const key = canonicalJson({ exit: o.exit, signal: o.signal, timeout: o.timeout, stdout: o.stdout, stderr: o.stderr, fs: o.fs, features: c.case.features });
  behaviorKeys.set(c, key);
  return key;
}

/** Decides which observed cases stay, in the order they are offered. */
class Selector {
  readonly accepted: CorpusCase[] = [];
  private readonly samples = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  private deferred: CorpusCase[] = [];
  private duplicates = 0;
  private overBudget = 0;
  /** A case that isn't an error was kept since the last retry, so waiting errors may fit now. */
  private roomGrew = false;

  constructor(
    private readonly budget: number,
    private readonly cap: number,
  ) {}

  get size(): number {
    return this.accepted.length;
  }

  get full(): boolean {
    return this.accepted.length >= this.budget;
  }

  /** Kept cases tagged with `feature`. */
  count(feature: string): number {
    return this.totals.get(feature) ?? 0;
  }

  /** Keeps the case if the filters allow it now; an error case over the cap waits. True if kept. */
  offer(c: CorpusCase): boolean {
    if (this.full) {
      this.overBudget++;
      return false;
    }
    if ((this.samples.get(behaviorKey(c)) ?? 0) >= DEDUP_SAMPLE) {
      this.duplicates++;
      return false;
    }
    if (isErrorObservation(c.observation) && !this.errorFits(c)) {
      this.deferred.push(c);
      return false;
    }
    this.keep(c);
    return true;
  }

  /** Offers the waiting error cases again, in their original order, now that more cases are kept. */
  retryDeferred(): void {
    // Once the budget is full they stay counted as dropped by the cap.
    if (!this.roomGrew || this.full) return;
    this.roomGrew = false;
    const waiting = this.deferred;
    this.deferred = [];
    for (const c of waiting) this.offer(c);
  }

  dropped(): CorpusStats['dropped'] {
    return { duplicate: this.duplicates, errorCap: this.deferred.length, budget: this.overBudget };
  }

  private groups(c: CorpusCase): string[] {
    return [...c.case.features, ALL];
  }

  /** One more error case keeps every group it counts in at or under the cap. */
  private errorFits(c: CorpusCase): boolean {
    return this.groups(c).every((g) => (this.errors.get(g) ?? 0) + 1 <= this.cap * ((this.totals.get(g) ?? 0) + 1) + 1e-9);
  }

  private keep(c: CorpusCase): void {
    const key = behaviorKey(c);
    this.samples.set(key, (this.samples.get(key) ?? 0) + 1);
    const error = isErrorObservation(c.observation);
    if (!error) this.roomGrew = true;
    for (const g of this.groups(c)) {
      this.totals.set(g, (this.totals.get(g) ?? 0) + 1);
      if (error) this.errors.set(g, (this.errors.get(g) ?? 0) + 1);
    }
    this.accepted.push(c);
  }
}

/**
 * Cases in round-robin order over their features (sorted by name, untagged cases as one more
 * group): each round takes the next case not yet taken that carries the feature. Within a
 * feature, generation order is kept.
 */
function roundRobin<T extends { case: CanonicalCase }>(cases: readonly T[]): T[] {
  const queues = new Map<string, number[]>();
  cases.forEach((c, i) => {
    for (const f of c.case.features.length > 0 ? c.case.features : ['']) {
      if (!queues.has(f)) queues.set(f, []);
      queues.get(f)!.push(i);
    }
  });
  const order = [...queues.keys()].sort().map((f) => ({ queue: queues.get(f)!, at: 0 }));
  const taken = new Set<number>();
  const out: T[] = [];
  while (out.length < cases.length) {
    for (const q of order) {
      while (q.at < q.queue.length && taken.has(q.queue[q.at]!)) q.at++;
      if (q.at === q.queue.length) continue;
      const i = q.queue[q.at++]!;
      taken.add(i);
      out.push(cases[i]!);
    }
  }
  return out;
}

/**
 * The parent case with one input replaced by a byte mutant: its stdin or one of its fixtures,
 * starting from that input or from a seed fixture, with one to `MAX_STACKED` mutations stacked.
 * Argv, env and features stay the parent's.
 */
function mutateCase(parent: CanonicalCase, rng: Rng, blobs: Map<string, Uint8Array>, seeds: readonly Uint8Array[], features = parent.features): CanonicalCase {
  const inputs: (string | null)[] = [...(parent.stdin === null ? [] : [null]), ...Object.keys(parent.fixtures).sort()];
  const bytesOf = (ref: string) => {
    const bytes = blobs.get(ref);
    if (bytes === undefined) throw new Error(`no content for ${ref}`);
    return bytes;
  };
  // A case without stdin or fixtures gets stdin.
  const target = inputs.length === 0 ? null : rng.pick(inputs);
  const current = target === null ? (parent.stdin === null ? new Uint8Array() : bytesOf(parent.stdin)) : bytesOf(parent.fixtures[target]!);
  let bytes = seeds.length > 0 && rng.int(2) === 1 ? rng.pick(seeds) : current;
  const stacked = 1 + rng.int(MAX_STACKED);
  for (let i = 0; i < stacked; i++) bytes = mutateBytes(bytes, rng, seeds).bytes;
  const ref = blobRef(bytes);
  if (!blobs.has(ref)) blobs.set(ref, bytes);
  return canonicalCase({
    argv: parent.argv,
    env: parent.env,
    stdin: target === null ? ref : parent.stdin,
    fixtures: target === null ? parent.fixtures : { ...parent.fixtures, [target]: ref },
    features,
    origin: 'generated',
  });
}

/** Committed cases sorted by ID, one per ID. */
function canonicalOrder(cases: readonly CanonicalCase[]): CanonicalCase[] {
  const byId = new Map<string, CanonicalCase>();
  for (const c of cases) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A committed case's features for targeting and for its mutants: `base` when it has none. */
function tagsOf(c: CanonicalCase): readonly string[] {
  return c.features.length > 0 ? c.features : ['base'];
}

/**
 * Indexes of a case's arguments that carry code or data rather than options or files: not a flag
 * (or `-`), not empty, not the path of one of its fixtures.
 */
function codeArguments(c: CanonicalCase): number[] {
  return c.argv.flatMap((arg, i) => (arg !== '' && !arg.startsWith('-') && !Object.hasOwn(c.fixtures, arg) ? [i] : []));
}

/**
 * A mutant of a committed case (generator v2): half the time one of its code arguments with one
 * whole-token mutation from a dictionary of all the committed code arguments (which also donate
 * splices), else, or when that gives nothing new and safe, a byte mutant of its stdin or a fixture
 * as `mutateCase` makes. Safe means no argument becomes an absolute or `..` path, and (unless
 * `iKnow`) the call doesn't turn into a destructive one the parent wasn't, such as `git push` out of
 * `git log`. The mutant keeps the parent's features (`base` when it has none).
 */
function mutateCommitted(
  parent: CanonicalCase,
  rng: Rng,
  blobs: Map<string, Uint8Array>,
  seeds: readonly Uint8Array[],
  tokens: { dictionary: TokenDictionary; donors: readonly string[]; program: string; iKnow: boolean },
): { case: CanonicalCase; strategy: CorpusStrategy } {
  const features = [...tagsOf(parent)];
  const code = codeArguments(parent);
  if (code.length > 0 && tokens.dictionary.size > 0 && rng.int(2) === 0) {
    const at = rng.pick(code);
    const { text } = mutateTokens(parent.argv[at]!, rng, tokens.dictionary, tokens.donors);
    const argv = parent.argv.map((arg, i) => (i === at ? text : arg));
    const destructive = !tokens.iKnow && destructiveCommand([tokens.program, ...argv]) !== null && destructiveCommand([tokens.program, ...parent.argv]) === null;
    if (text !== parent.argv[at] && isSafeArgvToken(text) && !destructive) {
      return { case: canonicalCase({ argv, env: parent.env, stdin: parent.stdin, fixtures: parent.fixtures, features, origin: 'generated' }), strategy: 'token-mutation' };
    }
  }
  return { case: mutateCase(parent, rng, blobs, seeds, features), strategy: 'mutation' };
}

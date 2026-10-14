import { createRng, type GeneratorVersion, type Rng } from './rng.js';
import { EDGE, pairKey, tokenShape, tokenize, type Token, type TokenDictionary, type TokenKind } from './token-dictionary.js';

export const TOKEN_MUTATION_OPS = ['replace', 'splice', 'insert'] as const;
export type TokenMutationOp = (typeof TOKEN_MUTATION_OPS)[number];

export interface TokenMutant {
  text: string;
  op: TokenMutationOp;
  /** Index of the seed it was derived from. */
  parent: number;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(OPENERS));
const MAX_SPLICE = 8;
const ATTEMPTS = 16;

/**
 * Applies one whole-token mutation to `text`:
 * - `replace` swaps a token for a dictionary token of the same kind (a word for a word, an operator
 *   for an operator); delimiters are left alone so brackets stay balanced;
 * - `splice` replaces a bracket-balanced run of tokens with a balanced run from a donor;
 * - `insert` puts one dictionary token at a token boundary.
 * Each op first looks for a choice whose new neighbour pairs were seen in the dictionary's sources
 * (a function name where a function name stood, `|` between two filters) and only then falls back
 * to an unguided one, the way AFL does. A space is added wherever a new token would otherwise merge
 * with its neighbour (`a` next to `b`, `=` next to `=`). Weights are replace 3 : splice 2 :
 * insert 1; an op that has nothing to work on falls through to the next one.
 */
export function mutateTokens(text: string, rng: Rng, dictionary: TokenDictionary, donors: readonly string[] = []): { text: string; op: TokenMutationOp } {
  const tokens = tokenize(text);
  const roll = rng.int(6);
  const order: TokenMutationOp[] = roll < 3 ? ['replace', 'splice', 'insert'] : roll < 5 ? ['splice', 'replace', 'insert'] : ['insert', 'replace', 'splice'];
  for (const op of order) {
    const out = op === 'replace' ? replace(tokens, rng, dictionary) : op === 'splice' ? splice(tokens, rng, dictionary, donors) : insert(tokens, rng, dictionary);
    if (out !== undefined) return { text: out, op };
  }
  return { text, op: 'insert' }; // empty text and an empty dictionary: nothing to do
}

/**
 * Derives `count` mutants from `seeds`, one token mutation each. The parent is picked at random and
 * splice donors come from all seeds. The output depends only on the seeds (in order), the dictionary,
 * `seed` and the generator version. A mutant equal to its parent is redrawn a few times before it is
 * kept, so a seed with nothing to mutate cannot stall generation.
 */
export function generateTokenMutants(
  seeds: readonly string[],
  options: { dictionary: TokenDictionary; count: number; seed: string | number; generator: GeneratorVersion },
): TokenMutant[] {
  if (seeds.length === 0) throw new RangeError('Token mutation needs at least one seed.');
  const rng = createRng(options.seed, options.generator);
  const mutants: TokenMutant[] = [];
  for (let i = 0; i < options.count; i++) {
    const parent = rng.int(seeds.length);
    let mutant = mutateTokens(seeds[parent]!, rng, options.dictionary, seeds);
    for (let retry = 0; retry < ATTEMPTS && mutant.text === seeds[parent]; retry++) {
      mutant = mutateTokens(seeds[parent]!, rng, options.dictionary, seeds);
    }
    mutants.push({ ...mutant, parent });
  }
  return mutants;
}

function replace(tokens: Token[], rng: Rng, dictionary: TokenDictionary): string | undefined {
  const targets = positions(tokens, (t) => t.kind !== 'delimiter' && (dictionary.byKind.get(t.kind)?.some((d) => d !== t.text) ?? false));
  if (targets.length === 0) return undefined;
  const swap = (at: number, text: string) => join([...tokens.slice(0, at), { kind: tokens[at]!.kind, text, fresh: true }, ...tokens.slice(at + 1)]);
  let at = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    at = rng.pick(targets);
    const { kind, text } = tokens[at]!;
    const left = shapeBefore(tokens, at);
    const right = shapeAfter(tokens, at + 1);
    const fitting = dictionary.byKind.get(kind)!.filter((d) => d !== text && fits(dictionary, left, tokenShape({ kind, text: d }), right));
    if (fitting.length > 0) return swap(at, rng.pick(fitting));
  }
  const current = tokens[at]!;
  return swap(at, rng.pick(dictionary.byKind.get(current.kind)!.filter((d) => d !== current.text)));
}

function insert(tokens: Token[], rng: Rng, dictionary: TokenDictionary): string | undefined {
  if (dictionary.kinds.length === 0) return undefined;
  const put = (at: number, token: Token) => join([...tokens.slice(0, at), { ...token, fresh: true }, ...tokens.slice(at)]);
  const all = dictionary.kinds.flatMap((kind) => dictionary.byKind.get(kind)!.map((text) => ({ kind, text })));
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const at = rng.int(tokens.length + 1);
    const left = shapeBefore(tokens, at);
    const right = shapeAfter(tokens, at);
    const fitting = all.filter((t) => !(t.text in OPENERS) && !CLOSERS.has(t.text) && fits(dictionary, left, tokenShape(t), right));
    if (fitting.length > 0) return put(at, rng.pick(fitting));
  }
  const kind: TokenKind = rng.pick(dictionary.kinds);
  return put(rng.int(tokens.length + 1), { kind, text: rng.pick(dictionary.byKind.get(kind)!) });
}

function splice(tokens: Token[], rng: Rng, dictionary: TokenDictionary, donors: readonly string[]): string | undefined {
  if (donors.length === 0) return undefined;
  let result: string | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const target = balancedRun(tokens, rng);
    const donorTokens = tokenize(rng.pick(donors));
    const piece = balancedRun(donorTokens, rng);
    if (target === undefined || piece === undefined) continue;
    const run = donorTokens.slice(piece[0], piece[1]);
    result = join([...tokens.slice(0, target[0]), ...run.map((t) => ({ ...t, fresh: true })), ...tokens.slice(target[1])]);
    const first = run[0]!;
    const last = run.at(-1)!;
    if (fits(dictionary, shapeBefore(tokens, target[0]), tokenShape(first), EDGE, false) && fits(dictionary, EDGE, tokenShape(last), shapeAfter(tokens, target[1]), true)) {
      return result;
    }
  }
  return result;
}

/**
 * Whether `shape` was seen after `left` and before `right`. With `side`, only that side is checked:
 * `false` checks the left pair, `true` the right one.
 */
function fits(dictionary: TokenDictionary, left: string, shape: string, right: string, side?: boolean): boolean {
  return (side === true || dictionary.pairs.has(pairKey(left, shape))) && (side === false || dictionary.pairs.has(pairKey(shape, right)));
}

/** Shape of the last non-space token before index `at`, or `EDGE`. */
function shapeBefore(tokens: Token[], at: number): string {
  for (let i = at - 1; i >= 0; i--) if (tokens[i]!.kind !== 'space') return tokenShape(tokens[i]!);
  return EDGE;
}

/** Shape of the first non-space token at or after index `at`, or `EDGE`. */
function shapeAfter(tokens: Token[], at: number): string {
  for (let i = at; i < tokens.length; i++) if (tokens[i]!.kind !== 'space') return tokenShape(tokens[i]!);
  return EDGE;
}

/** A random run `[start, end)` of 1–8 non-space tokens whose brackets balance, trimmed of spaces at both ends. */
function balancedRun(tokens: Token[], rng: Rng): [number, number] | undefined {
  const starts = positions(tokens, (t) => t.kind !== 'space' && !CLOSERS.has(t.text));
  if (starts.length === 0) return undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const start = rng.pick(starts);
    const want = 1 + rng.int(MAX_SPLICE);
    const stack: string[] = [];
    let taken = 0;
    for (let i = start; i < tokens.length && taken < want; i++) {
      const t = tokens[i]!;
      if (t.kind === 'space') continue;
      taken++;
      if (t.text in OPENERS) stack.push(OPENERS[t.text]!);
      else if (CLOSERS.has(t.text) && stack.pop() !== t.text) break;
      if (stack.length === 0 && taken === want) return [start, i + 1];
    }
    if (stack.length === 0 && taken > 0 && taken < want) {
      // Ran out of tokens with the brackets closed: the run up to the last non-space token is fine.
      let end = tokens.length;
      while (tokens[end - 1]!.kind === 'space') end--;
      if (balanced(tokens.slice(start, end))) return [start, end];
    }
  }
  return undefined;
}

function balanced(tokens: Token[]): boolean {
  const stack: string[] = [];
  for (const t of tokens) {
    if (t.text in OPENERS) stack.push(OPENERS[t.text]!);
    else if (CLOSERS.has(t.text) && stack.pop() !== t.text) return false;
  }
  return stack.length === 0;
}

function positions(tokens: Token[], keep: (t: Token) => boolean): number[] {
  const out: number[] = [];
  tokens.forEach((t, i) => keep(t) && out.push(i));
  return out;
}

type Placed = Token & { fresh?: boolean };

/**
 * Joins tokens, adding a space where a new token meets a neighbour and the two would lex as
 * something else when touching. Junctions inside the old text or inside a spliced run are kept as they were.
 */
function join(tokens: Placed[]): string {
  let out = '';
  let prev: Placed | undefined;
  for (const t of tokens) {
    if (prev && Boolean(prev.fresh) !== Boolean(t.fresh) && prev.kind !== 'space' && t.kind !== 'space' && !separate(prev.text, t.text)) out += ' ';
    out += t.text;
    prev = t;
  }
  return out;
}

function separate(a: string, b: string): boolean {
  const lexed = tokenize(a + b);
  return lexed.length === 2 && lexed[0]!.text === a;
}

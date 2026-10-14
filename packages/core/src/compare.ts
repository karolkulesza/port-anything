import type { BlobStore } from './blob-store.js';
import { canonicalJson } from './canonical-json.js';
import type { Observation } from './model.js';
import { PROGRAM_PLACEHOLDER, replaceProgramNames } from './normalize.js';

/** The observation fields a comparison looks at, in the order divergences are listed. */
export const COMPARED_FIELDS = ['exit', 'signal', 'timeout', 'stdout', 'stderr', 'fs'] as const;

export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** How a candidate's observation of a case relates to the reference's. */
export interface Comparison {
  verdict: 'match' | 'diverge';
  /** The fields that differ, in `COMPARED_FIELDS` order; empty for a match. */
  fields: ComparedField[];
}

/**
 * Compares two observations field by field, byte for byte: no normalizers, no tolerance. Output
 * blobs are compared by ref, the fs diff by content (key order doesn't matter). Duration, memory
 * and run counts are never compared.
 */
export function compareExact(reference: Observation, candidate: Observation): Comparison {
  const fields = COMPARED_FIELDS.filter((field) => !sameValue(field, reference, candidate));
  return { verdict: fields.length === 0 ? 'match' : 'diverge', fields };
}

function sameValue(field: ComparedField, a: Observation, b: Observation): boolean {
  if (field !== 'fs') return a[field] === b[field];
  const fs = (o: Observation) => canonicalJson({ ...o.fs, deleted: [...new Set(o.fs.deleted)].sort() });
  return fs(a) === fs(b);
}

/** Strictness profiles, from the most fields counted to the fewest. */
export const PROFILES = ['strict', 'standard', 'lenient'] as const;

export type Profile = (typeof PROFILES)[number];

/**
 * The fields whose divergence makes a case diverge under each profile. The exit status (code,
 * signal, timeout) always counts. `standard` compares stderr loosely by default (see `StderrOptions`).
 */
export const PROFILE_FIELDS: Readonly<Record<Profile, readonly ComparedField[]>> = {
  strict: COMPARED_FIELDS,
  standard: COMPARED_FIELDS,
  lenient: ['exit', 'signal', 'timeout', 'stdout'],
};

/** How stderr is compared when the profile counts it (`compare.fields.stderr`). */
export interface StderrOptions {
  /** `exact`: byte for byte. `loose`: see `looseStderrMatch`. Default: `exact` under strict, `loose` under standard. */
  mode?: 'exact' | 'loose' | undefined;
  /** Loose mode: the word similarity at or above which two different messages still match. Default 0.6. */
  similarity?: number;
}

export const DEFAULT_STDERR_SIMILARITY = 0.6;

export interface CompareOptions {
  profile: Profile;
  stderr?: StderrOptions;
}

/** The stderr mode a profile ends up with once the configured mode, if any, is applied. */
export function stderrMode(options: CompareOptions): 'exact' | 'loose' {
  return options.stderr?.mode ?? (options.profile === 'strict' ? 'exact' : 'loose');
}

/** Coarse outcome of a run, for loose stderr: a usage error is exit 2 (getopt tools) or 64 (`EX_USAGE`). */
export type ExitClass = 'success' | 'usage' | 'error' | 'signal';

export function exitClass(o: Observation): ExitClass {
  if (o.exit === null || o.signal !== null || o.timeout) return 'signal';
  if (o.exit === 0) return 'success';
  return o.exit === 2 || o.exit === 64 ? 'usage' : 'error';
}

const WORD = new RegExp(`${PROGRAM_PLACEHOLDER}|[\\p{L}\\p{N}]+`, 'gu');

/**
 * Word similarity of two messages: twice the number of words they share (counting repeats) over
 * the number of words in both (Sørensen–Dice), case-insensitive, punctuation ignored. 1 when
 * neither has a word.
 */
export function stderrSimilarity(a: string, b: string): number {
  const words = (s: string) => s.toLowerCase().match(WORD) ?? [];
  const wa = words(a);
  const wb = words(b);
  if (wa.length + wb.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

const lossyUtf8 = new TextDecoder('utf-8');
const foldWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Loose stderr: both empty or both not, the same exit class, and the messages equal once each
 * side's program names are replaced and whitespace is folded, or at least `similarity` alike.
 */
function looseStderrMatch(reference: { observation: Observation; text: string; names: readonly string[] }, candidate: typeof reference, similarity: number): boolean {
  if ((reference.text === '') !== (candidate.text === '')) return false;
  if (exitClass(reference.observation) !== exitClass(candidate.observation)) return false;
  const r = foldWhitespace(replaceProgramNames(reference.text, reference.names));
  const c = foldWhitespace(replaceProgramNames(candidate.text, candidate.names));
  return r === c || stderrSimilarity(r, c) >= similarity;
}

export interface CompareObservationsOptions extends CompareOptions {
  /** Holds both sides' stderr, read for a loose comparison. */
  store: BlobStore;
  /** Names each side's program can call itself, replaced in stderr before a loose comparison. */
  programNames: { reference: readonly string[]; candidate: readonly string[] };
}

/**
 * Compares two (already normalized) observations under a strictness profile: the fields the
 * profile counts, each byte for byte except stderr in loose mode. A difference in a field the
 * profile doesn't count is not a divergence. Loose never asks more than exact: stderr that is the
 * same byte for byte matches, even across exit classes (the exit code diverges on its own).
 */
export async function compareObservations(reference: Observation, candidate: Observation, options: CompareObservationsOptions): Promise<Comparison> {
  const counted = PROFILE_FIELDS[options.profile];
  const fields: ComparedField[] = [];
  for (const field of counted) {
    if (sameValue(field, reference, candidate)) continue;
    if (field === 'stderr' && stderrMode(options) === 'loose') {
      const [r, c] = await Promise.all([options.store.get(reference.stderr), options.store.get(candidate.stderr)]);
      const side = (observation: Observation, bytes: Buffer, names: readonly string[]) => ({ observation, text: lossyUtf8.decode(bytes), names });
      const similarity = options.stderr?.similarity ?? DEFAULT_STDERR_SIMILARITY;
      if (looseStderrMatch(side(reference, r, options.programNames.reference), side(candidate, c, options.programNames.candidate), similarity)) continue;
    }
    fields.push(field);
  }
  return { verdict: fields.length === 0 ? 'match' : 'diverge', fields };
}

import type { BlobStore } from './blob-store.js';
import type { ComparedField } from './compare.js';
import type { Observation } from './model.js';

/**
 * The kinds of difference the classifier tells apart, from the most specific to the catch-all.
 * Text fields try them in this order and take the first that fits.
 */
export const DIFF_SHAPES = [
  /** The exit status differs (code, signal or timeout). */
  'exit-code',
  /** One side wrote nothing, the other something. */
  'empty',
  /** The outputs differ only by a final newline. */
  'missing-trailing-newline',
  /** The outputs differ only in whitespace. */
  'whitespace-only',
  /** The same lines, in a different order. */
  'line-order',
  /** The same text and the same numbers, written differently (`1` and `1.0`, `007` and `7`, `1e3` and `1000`). */
  'number-format',
  /** The same text around numbers whose values differ. */
  'number-value',
  /** One output starts or ends the other: cut short, or with something extra. */
  'prefix-suffix',
  /** Two different error messages (stderr only). */
  'message-text',
  /** Different files created, modified or deleted. */
  'file-set',
  /** None of the above. */
  'other',
] as const;

export type DiffShape = (typeof DIFF_SHAPES)[number];

/**
 * The shape of one diverging field. `detail` narrows a shape without naming any output (for
 * example `0 vs 2` for an exit code, or which side is empty), so it can be part of a signature.
 */
export interface FieldShape {
  field: ComparedField;
  shape: DiffShape;
  detail?: string;
}

export type TextShape = Omit<FieldShape, 'field'>;

// Outputs are compared as bytes: latin1 maps each byte to one character, so non-UTF-8 output keeps
// its length and the heuristics below only ever look at ASCII.
const asText = (bytes: Buffer) => bytes.toString('latin1');

const WHITESPACE = /[ \t\n\r\f\v]+/g;
// A decimal number: optional sign, digits with an optional fraction (or a bare fraction), optional
// exponent. A full stop after the digits ends a sentence, not a number.
const NUMBER = /[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?/g;
const NUMBER_PARTS = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/;

/**
 * Classifies how two different texts differ (reference first). `field` only matters for stderr,
 * where two unrelated non-empty messages are `message-text` rather than `other`.
 */
export function classifyText(reference: string, candidate: string, field?: ComparedField): TextShape {
  if (reference === candidate) throw new Error('classifyText: the texts are equal');
  if (reference === '' || candidate === '') return { shape: 'empty', detail: reference === '' ? 'reference empty' : 'candidate empty' };
  // Only when the shorter side doesn't end a line: one more `\n` after a `\n` is an extra blank line.
  if (reference === `${candidate}\n` && !candidate.endsWith('\n')) return { shape: 'missing-trailing-newline', detail: 'candidate' };
  if (candidate === `${reference}\n` && !reference.endsWith('\n')) return { shape: 'missing-trailing-newline', detail: 'reference' };
  if (reference.replace(WHITESPACE, '') === candidate.replace(WHITESPACE, '')) return { shape: 'whitespace-only' };
  if (sameLines(reference, candidate)) return { shape: 'line-order' };
  const numbers = numberShape(reference, candidate);
  if (numbers) return { shape: numbers };
  if (candidate.startsWith(reference)) return { shape: 'prefix-suffix', detail: 'candidate adds to the end' };
  if (reference.startsWith(candidate)) return { shape: 'prefix-suffix', detail: 'candidate stops early' };
  if (candidate.endsWith(reference)) return { shape: 'prefix-suffix', detail: 'candidate adds to the start' };
  if (reference.endsWith(candidate)) return { shape: 'prefix-suffix', detail: 'candidate misses the start' };
  return { shape: field === 'stderr' ? 'message-text' : 'other' };
}

/** Order-only: the same lines, counting repeats, once both are sorted. */
function sameLines(a: string, b: string): boolean {
  const sorted = (s: string) => s.split('\n').sort();
  const la = sorted(a);
  const lb = sorted(b);
  return la.length === lb.length && la.every((line, i) => line === lb[i]);
}

/** `number-format` or `number-value` when the texts are equal with every number masked, else undefined. */
function numberShape(a: string, b: string): 'number-format' | 'number-value' | undefined {
  const na = a.match(NUMBER) ?? [];
  const nb = b.match(NUMBER) ?? [];
  if (na.length === 0 || na.length !== nb.length) return undefined;
  if (a.replace(NUMBER, '0') !== b.replace(NUMBER, '0')) return undefined;
  return na.every((n, i) => exactValue(n) === exactValue(nb[i]!)) ? 'number-format' : 'number-value';
}

/**
 * A number literal's exact value as `<sign><digits>e<exponent>`, with no leading or trailing zero
 * digit, so two literals have the same form exactly when they have the same value (no rounding,
 * however many digits or however large the exponent).
 */
function exactValue(literal: string): string {
  const [, sign, int = '', frac = '', exp = '0'] = NUMBER_PARTS.exec(literal)!;
  const digits = `${int}${frac}`.replace(/^0+/, '');
  if (digits === '') return '0';
  const significant = digits.replace(/0+$/, '');
  const exponent = BigInt(exp) - BigInt(frac.length) + BigInt(digits.length - significant.length);
  return `${sign === '-' ? '-' : ''}${significant}e${exponent}`;
}

/** How a run ended, as written in an `exit-code` detail: the code, the signal name or `timeout`. */
function status(o: Observation): string {
  if (o.timeout) return 'timeout';
  return o.signal ?? String(o.exit);
}

/**
 * Classifies each diverging field of a case (as listed by the comparison, both observations already
 * normalized). Exit, signal and timeout all get `exit-code` with both statuses; stdout and stderr
 * are classified as text; fs is `file-set` when the changed paths differ, else the shape of the
 * first file (by path) whose content differs. The path is left out, so cases writing different
 * files can share a signature.
 */
export async function classifyDiff(reference: Observation, candidate: Observation, fields: readonly ComparedField[], store: BlobStore): Promise<FieldShape[]> {
  const read = async (ref: string) => asText(await store.get(ref));
  const shapes: FieldShape[] = [];
  for (const field of fields) {
    if (field === 'exit' || field === 'signal' || field === 'timeout') {
      shapes.push({ field, shape: 'exit-code', detail: `${status(reference)} vs ${status(candidate)}` });
    } else if (field === 'stdout' || field === 'stderr') {
      shapes.push({ field, ...classifyText(await read(reference[field]), await read(candidate[field]), field) });
    } else {
      shapes.push({ field, ...(await fsShape(reference.fs, candidate.fs, read)) });
    }
  }
  return shapes;
}

async function fsShape(a: Observation['fs'], b: Observation['fs'], read: (ref: string) => Promise<string>): Promise<TextShape> {
  const paths = (fs: Observation['fs']) =>
    [...Object.keys(fs.created).map((p) => `+${p}`), ...Object.keys(fs.modified).map((p) => `~${p}`), ...[...new Set(fs.deleted)].map((p) => `-${p}`)].sort().join('\0');
  if (paths(a) !== paths(b)) return { shape: 'file-set' };
  const contents = (fs: Observation['fs']) => ({ ...fs.created, ...fs.modified });
  const ca = contents(a);
  const cb = contents(b);
  const path = Object.keys(ca)
    .sort()
    .find((p) => ca[p] !== cb[p]);
  if (path === undefined) return { shape: 'other' };
  const [ta, tb] = [await read(ca[path]!), await read(cb[path]!)];
  return { shape: classifyText(ta, tb).shape };
}

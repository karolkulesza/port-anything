/** Shortest prefix a user may type, as in git: shorter ones match too much to be useful. */
export const MIN_PREFIX_LENGTH = 4;

/** Length of the hex part of a displayed case ID (`c_9f2e1a4b`). Display only, never stored. */
export const SHORT_ID_LENGTH = 8;

export type CaseIdErrorCode = 'invalid' | 'not-found' | 'ambiguous';

export class CaseIdError extends Error {
  override readonly name = 'CaseIdError';
  constructor(
    readonly code: CaseIdErrorCode,
    message: string,
    /** For `ambiguous`: every full ID the prefix matches, sorted. */
    readonly matches: readonly string[] = [],
  ) {
    super(message);
  }
}

const hexOf = (id: string) => id.slice('sha256:'.length);

/** Display form of a full case ID: `c_` and the first `length` hex digits. */
export function shortCaseId(id: string, length = SHORT_ID_LENGTH): string {
  return `c_${hexOf(id).slice(0, length)}`;
}

/**
 * Resolves what a user typed (`c_9f2e`, `sha256:9f2e…` or bare hex, any case) to the one full ID
 * among `ids` that starts with it. Throws a `CaseIdError` when the input is malformed, matches
 * nothing, or matches more than one case.
 */
export function resolveCaseId(input: string, ids: Iterable<string>): string {
  const typed = input.trim();
  const hex = typed.replace(/^(c_|sha256:)/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length > 64) {
    throw new CaseIdError('invalid', `"${input}" is not a case ID: expected c_<hex>, sha256:<hex> or hex digits.`);
  }
  if (hex.length < MIN_PREFIX_LENGTH) {
    throw new CaseIdError('invalid', `"${input}" is too short: give at least ${MIN_PREFIX_LENGTH} hex digits.`);
  }
  const matches = [...new Set([...ids].filter((id) => hexOf(id).startsWith(hex)))].sort();
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CaseIdError('not-found', `No case matches "${input}".`);
  const length = Math.max(SHORT_ID_LENGTH, distinguishingLength(matches));
  const shown = matches.slice(0, 10).map((id) => shortCaseId(id, length));
  const more = matches.length > shown.length ? `, and ${matches.length - shown.length} more` : '';
  throw new CaseIdError(
    'ambiguous',
    `"${input}" matches ${matches.length} cases: ${shown.join(', ')}${more}. Give a longer prefix.`,
    matches,
  );
}

/** Hex digits needed to tell every ID in a sorted, de-duplicated list apart. */
function distinguishingLength(sorted: readonly string[]): number {
  let longest = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = hexOf(sorted[i - 1]!), b = hexOf(sorted[i]!);
    let n = 0;
    while (n < a.length && a[n] === b[n]) n++;
    longest = Math.max(longest, n + 1);
  }
  return longest;
}

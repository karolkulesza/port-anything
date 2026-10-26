/** Share of the reference's answers above which one error answer dominates a generated corpus. */
export const DOMINANT_ERROR_SHARE = 0.5;

/** Longest quote of an error message in the diagnosis. */
const QUOTE = 72;

export interface WeakCorpusInput {
  /** Spec features no generated case carries. */
  untested: readonly string[];
  /** Cases the reference ran while generating. */
  observed: number;
  /** How often the reference gave its commonest error answer, and that answer's text (stderr, else stdout). */
  commonestError?: { answers: number; text: string };
}

/**
 * Why a generated corpus is weak, in one line: the spec features that got no case, and the share of
 * the reference's answers that were one and the same error when it is more than half of them (a spec
 * whose forms the program rejects gets its usage text back for almost every case, and dedup and the
 * error-path cap then leave features with nothing). Undefined when there is neither. The caller adds
 * what to check.
 */
export function weakCorpusDiagnosis(input: WeakCorpusInput): string | undefined {
  const { untested, observed, commonestError } = input;
  const dominant = commonestError !== undefined && observed > 0 && commonestError.answers / observed > DOMINANT_ERROR_SHARE ? commonestError : undefined;
  const answers =
    dominant === undefined ? undefined : `${Math.round((100 * dominant.answers) / observed)}% of the reference's answers were ${describeError(dominant.text)}`;
  if (untested.length === 0) return answers === undefined ? undefined : `${answers}, so most cases test only that`;
  const features = `${untested.length} feature${untested.length === 1 ? '' : 's'} got no case (${untested.join(', ')})`;
  return answers === undefined ? features : `${features}: ${answers}`;
}

/** "its usage text" for a usage message, else the error's first line, quoted. */
function describeError(text: string): string {
  if (/\busage\b/i.test(text)) return 'its usage text';
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return 'one error (no output)';
  return `one error ("${line.length > QUOTE ? `${line.slice(0, QUOTE).trimEnd()}…` : line}")`;
}

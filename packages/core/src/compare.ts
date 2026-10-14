import { canonicalJson } from './canonical-json.js';
import type { Observation } from './model.js';

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

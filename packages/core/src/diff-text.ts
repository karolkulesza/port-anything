import { BlobError, type BlobStore } from './blob-store.js';
import type { ComparedField } from './compare.js';
import type { Observation } from './model.js';

// What a reader sees of a divergence: the diverging fields of both sides, after the normalizers,
// as a short line diff. `run --cluster`, the HTML report and the MCP tools show the same text.

/**
 * A diverging field of a case as a run saves it, both sides after the normalizers: stdout and
 * stderr as blob refs (the content stays in the cache), the other fields as text.
 */
export interface SavedFieldOutputs {
  field: ComparedField;
  reference: string;
  candidate: string;
}

/** A diverging field of a case, both sides as text. */
export interface FieldDiff {
  field: ComparedField;
  reference: string;
  candidate: string;
}

/** The diverging `fields` of a case, as a run saves them (see `SavedFieldOutputs`). */
export function fieldOutputs(reference: Observation, candidate: Observation, fields: readonly ComparedField[]): SavedFieldOutputs[] {
  return fields.map((field) =>
    field === 'stdout' || field === 'stderr'
      ? { field, reference: reference[field], candidate: candidate[field] }
      : { field, reference: scalarText(reference, field), candidate: scalarText(candidate, field) },
  );
}

/** Saved field outputs as text, the stdout and stderr read from the store. */
export async function savedFieldDiffs(outputs: readonly SavedFieldOutputs[], store: BlobStore): Promise<FieldDiff[]> {
  const text = async (field: ComparedField, value: string) => (field === 'stdout' || field === 'stderr' ? blobText(value, store) : value);
  return Promise.all(outputs.map(async (o) => ({ field: o.field, reference: await text(o.field, o.reference), candidate: await text(o.field, o.candidate) })));
}

/** A field of an observation as text for a diff, stdout and stderr read from the store. */
export async function observationFieldText(o: Observation, field: ComparedField, store: BlobStore): Promise<string> {
  return field === 'stdout' || field === 'stderr' ? blobText(o[field], store) : scalarText(o, field);
}

function scalarText(o: Observation, field: Exclude<ComparedField, 'stdout' | 'stderr'>): string {
  switch (field) {
    case 'exit':
      return o.exit === null ? 'none (signal)' : String(o.exit);
    case 'signal':
      return o.signal ?? 'none';
    case 'timeout':
      return o.timeout ? 'timed out' : 'finished';
    case 'fs': {
      const lines = [
        ...Object.entries(o.fs.created).map(([path, ref]) => `created ${path} ${shortHash(ref)}`),
        ...Object.entries(o.fs.modified).map(([path, ref]) => `modified ${path} ${shortHash(ref)}`),
        ...o.fs.deleted.map((path) => `deleted ${path}`),
      ];
      return `${lines.sort().join('\n')}\n`;
    }
  }
}

/** A blob's content as UTF-8 text, or a line saying what it is when it isn't text or is gone. */
async function blobText(ref: string, store: BlobStore): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await store.get(ref);
  } catch (e) {
    if (e instanceof BlobError) return `<no longer in the cache, sha256 ${shortHash(ref)}>`;
    throw e;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `<${bytes.length} bytes, not UTF-8, sha256 ${shortHash(ref)}>`;
  }
}

/** The first 12 hex digits of a blob's hash. */
const shortHash = (ref: string) => ref.replace(/^blob:sha256:/, '').slice(0, 12);

/** Lines shown per side of a diff, and characters per line. */
const DIFF_LINES = 12;
const LINE_CHARACTERS = 160;
/** Unchanged lines shown before a difference. */
const CONTEXT_LINES = 2;

/** `text` cut to `max` characters, with `…` standing for the rest. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** A line as is, or as a JSON string when it holds a character that wouldn't show; cut. */
export function showLine(line: string): string {
  return cut(/^[ -~]*$/.test(line) && !/\s$/.test(line) ? line : JSON.stringify(line), LINE_CHARACTERS);
}

/**
 * A compact line diff of two texts: the unchanged lines at the start and end are left out (but a
 * couple before the change, for context), then the reference's lines (`-`) and the candidate's
 * (`+`) in between. Lines are shown as JSON strings when they hold a character that wouldn't
 * show, such as a trailing space or a tab.
 */
export function lineDiff(reference: string, candidate: string): string[] {
  if (reference === candidate) return [];
  const a = reference.split('\n');
  const b = candidate.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const side = (lines: string[], mark: string) => {
    const shown = lines.slice(0, DIFF_LINES).map((l) => `${mark} ${showLine(l)}`);
    if (lines.length > DIFF_LINES) shown.push(`${mark} … ${lines.length - DIFF_LINES} more lines`);
    return shown;
  };
  const context = a.slice(Math.max(0, start - CONTEXT_LINES), start).map((l) => `  ${showLine(l)}`);
  return [`@@ line ${start + 1}`, ...context, ...side(a.slice(start, a.length - end), '-'), ...side(b.slice(start, b.length - end), '+')];
}

/** A field's diff as lines: a line diff for stdout, stderr and changed files, one line otherwise. */
export function fieldDiffLines(d: FieldDiff): string[] {
  if (d.field === 'stdout' || d.field === 'stderr' || d.field === 'fs') return [`${d.field}:`, ...lineDiff(d.reference, d.candidate).map((l) => `  ${l}`)];
  return [`${d.field}: reference ${d.reference}, candidate ${d.candidate}`];
}

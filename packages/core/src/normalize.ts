import { z } from 'zod';
import type { BlobStore } from './blob-store.js';
import { isSymlinkBlob } from './fs-diff.js';
import type { Observation } from './model.js';

/** The built-in normalizers of this version, in the order the docs list them. */
export const NORMALIZER_NAMES = [
  'tmp-paths',
  'iso-timestamps',
  'pids',
  'ansi-codes',
  'trailing-whitespace',
  'float-tolerance',
  'regex',
  'program-name',
  'sort-lines',
] as const;

export type NormalizerName = (typeof NORMALIZER_NAMES)[number];

/**
 * Where a normalizer applies: `stdout`, `stderr`, `files` (every created or modified file), or
 * `files:<glob>` (those whose path relative to the case directory matches; `*` and `?` stay within
 * one path segment, `**` crosses them).
 */
export type ScopeEntry = 'stdout' | 'stderr' | 'files' | `files:${string}`;

const ScopeEntrySchema = z
  .string()
  .refine((s) => s === 'stdout' || s === 'stderr' || s === 'files' || (s.startsWith('files:') && s.length > 'files:'.length), {
    message: 'must be stdout, stderr, files or files:<glob>',
  })
  .transform((s) => s as ScopeEntry);

const ScopeSchema = z.preprocess((s) => (typeof s === 'string' ? [s] : s), z.array(ScopeEntrySchema).min(1));

const NoOptionsSchema = z.union([z.null(), z.strictObject({})]).transform(() => ({}));

const FloatToleranceSchema = z
  .union([z.null(), z.strictObject({ rtol: z.number().nonnegative().optional(), atol: z.number().nonnegative().optional() })])
  .transform((o) => ({ rtol: o?.rtol ?? 1e-9, atol: o?.atol ?? 0 }));

const RegexSchema = z
  .strictObject({
    pattern: z.string().min(1),
    replacement: z.string().default(''),
    flags: z.string().regex(/^(?!.*(.).*\1)[imsu]*$/, 'must be some of i, m, s, u, each at most once').default(''),
  })
  .superRefine((o, ctx) => {
    try {
      new RegExp(o.pattern, `${o.flags}g`);
    } catch (e) {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: `is not a valid regular expression: ${(e as Error).message}` });
    }
  });

const OPTIONS = {
  'tmp-paths': NoOptionsSchema,
  'iso-timestamps': NoOptionsSchema,
  pids: NoOptionsSchema,
  'ansi-codes': NoOptionsSchema,
  'trailing-whitespace': NoOptionsSchema,
  'float-tolerance': FloatToleranceSchema,
  regex: RegexSchema,
  'program-name': NoOptionsSchema,
  'sort-lines': NoOptionsSchema,
} as const;

/** A configured normalizer: which one, its options, and where it applies. */
export type NormalizerSpec = {
  [N in NormalizerName]: {
    name: N;
    options: z.output<(typeof OPTIONS)[N]>;
    /** Absent: the normalizer's default scope (`program-name`: stderr; the others: stdout, stderr, files). */
    scope?: ScopeEntry[];
    /** Absent: every case. Otherwise only cases tagged with one of these features or a sub-feature (`fmt` covers `fmt.json`). */
    features?: string[];
  };
}[NormalizerName];

/**
 * One entry of the `normalizers` list in `port-anything.yaml`: a name (`tmp-paths`), or a map with
 * one normalizer key holding its options plus optional `scope` and `features`
 * (`{ float-tolerance: { rtol: 1e-9 }, scope: stdout, features: [fmt.json] }`).
 */
export const NormalizerEntrySchema = z.union([z.string(), z.record(z.string(), z.unknown())]).transform((entry, ctx): NormalizerSpec => {
  const known = (name: string): name is NormalizerName => (NORMALIZER_NAMES as readonly string[]).includes(name);
  const unknownName = (name: string) => {
    ctx.addIssue({ code: 'custom', message: `unknown normalizer "${name}"; known: ${NORMALIZER_NAMES.join(', ')}` });
    return z.NEVER;
  };
  let name: string;
  let rawOptions: unknown = null;
  let rest: Record<string, unknown> = {};
  if (typeof entry === 'string') {
    name = entry;
  } else {
    const names = Object.keys(entry).filter((key) => key !== 'scope' && key !== 'features');
    if (names.length !== 1) {
      ctx.addIssue({ code: 'custom', message: `must name exactly one normalizer, found ${names.length === 0 ? 'none' : names.join(', ')}` });
      return z.NEVER;
    }
    name = names[0]!;
    rawOptions = entry[name];
    rest = entry;
  }
  if (!known(name)) return unknownName(name);
  const options = OPTIONS[name].safeParse(rawOptions);
  if (!options.success) {
    for (const issue of options.error.issues) {
      const message = rawOptions === null && name === 'regex' ? 'needs options: { pattern, replacement }' : issue.message;
      ctx.addIssue({ code: 'custom', path: [name, ...issue.path.map(String)], message });
    }
    return z.NEVER;
  }
  const spec = { name, options: options.data } as NormalizerSpec;
  if (rest.scope !== undefined) {
    const scope = ScopeSchema.safeParse(rest.scope);
    if (!scope.success) {
      for (const issue of scope.error.issues) ctx.addIssue({ code: 'custom', path: ['scope', ...issue.path.map(String)], message: issue.message });
      return z.NEVER;
    }
    spec.scope = scope.data;
  }
  if (rest.features !== undefined) {
    const features = z.array(z.string().min(1)).min(1).safeParse(rest.features);
    if (!features.success) {
      ctx.addIssue({ code: 'custom', path: ['features'], message: 'must be a non-empty list of feature names' });
      return z.NEVER;
    }
    spec.features = features.data;
  }
  return spec;
});

export const NormalizersSchema = z.array(NormalizerEntrySchema);

/** How a normalizer is shown in run output and reports: `float-tolerance(rtol=1e-9, atol=0) on stdout for fmt.json`. */
export function normalizerLabel(spec: NormalizerSpec): string {
  let label: string = spec.name;
  if (spec.name === 'float-tolerance') label += `(rtol=${spec.options.rtol}, atol=${spec.options.atol})`;
  if (spec.name === 'regex') label += `(/${spec.options.pattern}/${spec.options.flags} → ${JSON.stringify(spec.options.replacement)})`;
  if (spec.scope !== undefined) label += ` on ${spec.scope.join(', ')}`;
  if (spec.features !== undefined) label += ` for ${spec.features.join(', ')}`;
  return label;
}

/** What a normalizer needs to know about the side whose output it rewrites. */
export interface SideContext {
  /** Directories this side's run used whose paths can differ between runs or sides (case dir, program dir, scratch root). */
  tempRoots: readonly string[];
  /** Names this side's program can call itself (the name it ran as, its file name, a multicall tool). */
  programNames: readonly string[];
}

export const TMP_PLACEHOLDER = '<TMP>';
export const TIMESTAMP_PLACEHOLDER = '<TIMESTAMP>';
export const PID_PLACEHOLDER = '<PID>';
export const PROGRAM_PLACEHOLDER = '<PROGRAM>';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// A system temp directory and the entry right under it (`/tmp/tmp.Xa81`, macOS `/var/folders/ab/xyz/T/foo`).
const SYSTEM_TEMP = /(?<![\w./-])(?:\/private)?(?:\/var\/folders\/[^/\s'"`]+\/[^/\s'"`]+\/T|\/tmp|\/var\/tmp|\/dev\/shm)\/[^/\s'"`:]+/g;

function tmpPaths(text: string, side: SideContext): string {
  // Longest first, so a case dir inside the scratch root is replaced whole.
  for (const root of [...new Set(side.tempRoots)].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`${escapeRegex(root)}(?![^/\\s'"\`:])`, 'g'), TMP_PLACEHOLDER);
  }
  return text.replace(SYSTEM_TEMP, TMP_PLACEHOLDER);
}

// Date and time, with `T` (minutes required, seconds optional) or a space (seconds required),
// optional fraction and zone. A date or a time alone is left alone.
const ISO_TIMESTAMP =
  /(?<!\d)\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?| \d{2}:\d{2}:\d{2}(?:[.,]\d+)?)(?:Z|[+-]\d{2}(?::?\d{2})?)?(?!\d)/g;

// `pid 123`, `PID: 123`, `pid=123`, on one line. Other forms (a daemon log's `name[123]:` looks just
// like an indexed path such as `items[3]:`) are left to `regex`.
const PID_WORD = /\b(pids?)([ \t]*[=:#]?[ \t]*)\d+(?!\d)/gi;

// CSI (colors, cursor moves), OSC (titles, links) ended by BEL or ST, and two-byte escapes.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// ASCII only: in output that isn't UTF-8 (read as latin1) \s would also take bytes 0x85 and 0xA0.
const TRAILING_WHITESPACE = /[ \t\f\v]+(?=\r?\n|$)/g;

// A decimal number with a fraction or an exponent; integers are never treated as floats. A unit
// (`0.3s`) or a full stop may follow, but not more digits (`1.2.3` is a version, not a number).
const NUMBER = /(?<![\w.])[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?(?![\d_]|\.\d)/g;
const isFloat = (token: string) => /[.eE]/.test(token);

/**
 * Pairs the numbers of both texts in order; where the texts hold the same number of numbers and
 * both of a pair are floats within tolerance (`|a - b| <= max(rtol * max(|a|, |b|), atol)`), the
 * candidate's spelling is replaced by the reference's.
 */
function floatTolerance(reference: string, candidate: string, rtol: number, atol: number): string {
  const ref = reference.match(NUMBER) ?? [];
  const cand = candidate.match(NUMBER) ?? [];
  if (ref.length !== cand.length || ref.length === 0) return candidate;
  let i = 0;
  return candidate.replace(NUMBER, (token) => {
    const other = ref[i++]!;
    if (token === other || !isFloat(token) || !isFloat(other)) return token;
    const a = Number(other);
    const b = Number(token);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return token;
    return Math.abs(a - b) <= Math.max(rtol * Math.max(Math.abs(a), Math.abs(b)), atol) ? other : token;
  });
}

function programName(text: string, side: SideContext): string {
  const names = [...new Set(side.programNames)].filter((n) => n !== '').sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  // Where tools print their own name: at the start of a line (`sort: invalid option`), after
  // `Usage:` and in `Try 'sort --help'`. Elsewhere the name may be an ordinary word of the message.
  const pattern = new RegExp(
    `(?<=^|[Uu]sage:[ \\t]+|Try ['"‘\`])(?:/[^\\s:'"‘’\`]*/)?(?:${names.map(escapeRegex).join('|')})(?=$|[\\s:'"’\`])`,
    'gm',
  );
  return text.replace(pattern, PROGRAM_PLACEHOLDER);
}

/** Lines in code-unit order; a final newline stays at the end. For output whose line order varies between runs. */
function sortLines(text: string): string {
  const final = text.endsWith('\n');
  const lines = (final ? text.slice(0, -1) : text).split('\n');
  return lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n') + (final ? '\n' : '');
}

type Step = { side: (text: string, side: SideContext) => string } | { pair: (reference: string, candidate: string) => string };

function step(spec: NormalizerSpec): Step {
  switch (spec.name) {
    case 'tmp-paths':
      return { side: tmpPaths };
    case 'iso-timestamps':
      return { side: (t) => t.replace(ISO_TIMESTAMP, TIMESTAMP_PLACEHOLDER) };
    case 'pids':
      return { side: (t) => t.replace(PID_WORD, `$1$2${PID_PLACEHOLDER}`) };
    case 'ansi-codes':
      return { side: (t) => t.replace(ANSI, '') };
    case 'trailing-whitespace':
      return { side: (t) => t.replace(TRAILING_WHITESPACE, '') };
    case 'float-tolerance': {
      const { rtol, atol } = spec.options;
      return { pair: (r, c) => floatTolerance(r, c, rtol, atol) };
    }
    case 'regex': {
      const pattern = new RegExp(spec.options.pattern, `${spec.options.flags}g`);
      const { replacement } = spec.options;
      return { side: (t) => t.replace(pattern, replacement) };
    }
    case 'program-name':
      return { side: programName };
    case 'sort-lines':
      return { side: sortLines };
  }
}

const DEFAULT_SCOPE: readonly ScopeEntry[] = ['stdout', 'stderr', 'files'];

/** A field of an observation that normalizers rewrite: `stdout`, `stderr` or `file:<path>`. */
type TextField = 'stdout' | 'stderr' | `file:${string}`;

function inScope(spec: NormalizerSpec, field: TextField): boolean {
  const scope = spec.scope ?? (spec.name === 'program-name' ? ['stderr'] : DEFAULT_SCOPE);
  if (field === 'stdout' || field === 'stderr') return scope.includes(field);
  const path = field.slice('file:'.length);
  return scope.some((s) => s === 'files' || (s.startsWith('files:') && globRegex(s.slice('files:'.length)).test(path)));
}

function appliesToCase(spec: NormalizerSpec, features: readonly string[]): boolean {
  if (spec.features === undefined) return true;
  return spec.features.some((wanted) => features.some((f) => f === wanted || f.startsWith(`${wanted}.`)));
}

const globCache = new Map<string, RegExp>();

/** `*` and `?` match within a path segment, `**` across segments (`**\/` also matches nothing). */
export function globRegex(glob: string): RegExp {
  let cached = globCache.get(glob);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:[^/]*/)*';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += escapeRegex(c);
  }
  cached = new RegExp(`^${source}$`, 's');
  globCache.set(glob, cached);
  return cached;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Text as normalizers see it: UTF-8 when the bytes are valid UTF-8, otherwise one character per
 * byte (latin1), so binary output still round-trips byte for byte (see `encode`).
 */
function decode(bytes: Buffer): { text: string; encoding: 'utf8' | 'latin1' } {
  try {
    return { text: utf8.decode(bytes), encoding: 'utf8' };
  } catch {
    return { text: bytes.toString('latin1'), encoding: 'latin1' };
  }
}

/**
 * Bytes of normalized text, in the encoding it was read in. Characters a normalizer inserted into
 * latin1 text that latin1 can't hold (a `regex` replacement such as `→`) are written as UTF-8.
 */
function encode(text: string, encoding: 'utf8' | 'latin1'): Buffer {
  if (encoding === 'utf8' || !/[^\x00-\xff]/.test(text)) return Buffer.from(text, encoding);
  return Buffer.concat(text.split(/([^\x00-\xff]+)/).map((part, i) => Buffer.from(part, i % 2 === 1 ? 'utf8' : 'latin1')));
}

/** One side of a comparison: its observation and what normalizers need to know about it. */
export interface NormalizeSide {
  observation: Observation;
  context: SideContext;
}

export interface NormalizePairOptions {
  normalizers: readonly NormalizerSpec[];
  /** The features of the case, for normalizers scoped by feature. */
  features: readonly string[];
  reference: NormalizeSide;
  candidate: NormalizeSide;
  /** Holds the observed output; rewritten output is added to it. */
  store: BlobStore;
}

export interface NormalizedPair {
  reference: Observation;
  candidate: Observation;
  /** Indexes into `normalizers` of those that changed either side, ascending. */
  changedBy: number[];
}

/**
 * Applies the normalizers, in order, to both sides of one comparison: each output field and each
 * created or modified file in scope. Most rewrite each side on its own; `float-tolerance` looks at
 * both and only rewrites the candidate. Files whose content isn't in the store (too large to keep)
 * and symlinks are left as they are. Exit code, signal, timeout and the list of paths never change.
 */
export async function normalizePair(options: NormalizePairOptions): Promise<NormalizedPair> {
  const { normalizers, store } = options;
  const changed = new Set<number>();
  const active = normalizers.map((spec, index) => ({ spec, index, step: step(spec) })).filter((n) => appliesToCase(n.spec, options.features));
  if (active.length === 0) return { reference: options.reference.observation, candidate: options.candidate.observation, changedBy: [] };

  const load = async (ref: string | undefined): Promise<Buffer | undefined> => {
    if (ref === undefined || !(await store.has(ref))) return undefined;
    const bytes = await store.get(ref);
    return isSymlinkBlob(bytes) ? undefined : bytes;
  };

  /** Normalizes one field on both sides; either ref may be absent (a file only one side wrote). */
  const field = async (name: TextField, refBlob: string | undefined, candBlob: string | undefined): Promise<[string | undefined, string | undefined]> => {
    const steps = active.filter((n) => inScope(n.spec, name));
    if (steps.length === 0) return [refBlob, candBlob];
    const [refBytes, candBytes] = await Promise.all([load(refBlob), load(candBlob)]);
    const ref = refBytes === undefined ? undefined : decode(refBytes);
    const cand = candBytes === undefined ? undefined : decode(candBytes);
    let r = ref?.text;
    let c = cand?.text;
    for (const { index, step: s } of steps) {
      const before = [r, c];
      if ('side' in s) {
        if (r !== undefined) r = s.side(r, options.reference.context);
        if (c !== undefined) c = s.side(c, options.candidate.context);
      } else if (r !== undefined && c !== undefined) {
        c = s.pair(r, c);
      }
      if (r !== before[0] || c !== before[1]) changed.add(index);
    }
    const save = async (text: string | undefined, original: ReturnType<typeof decode> | undefined, blob: string | undefined) =>
      text === undefined || original === undefined || text === original.text ? blob : store.put(encode(text, original.encoding));
    return [await save(r, ref, refBlob), await save(c, cand, candBlob)];
  };

  const reference = { ...options.reference.observation, fs: structuredClone(options.reference.observation.fs) };
  const candidate = { ...options.candidate.observation, fs: structuredClone(options.candidate.observation.fs) };
  [reference.stdout, candidate.stdout] = (await field('stdout', reference.stdout, candidate.stdout)) as [string, string];
  [reference.stderr, candidate.stderr] = (await field('stderr', reference.stderr, candidate.stderr)) as [string, string];
  for (const kind of ['created', 'modified'] as const) {
    const paths = new Set([...Object.keys(reference.fs[kind]), ...Object.keys(candidate.fs[kind])]);
    for (const path of [...paths].sort()) {
      const [r, c] = await field(`file:${path}`, reference.fs[kind][path], candidate.fs[kind][path]);
      if (r !== undefined) reference.fs[kind][path] = r;
      if (c !== undefined) candidate.fs[kind][path] = c;
    }
  }
  return { reference, candidate, changedBy: [...changed].sort((a, b) => a - b) };
}

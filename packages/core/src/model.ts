import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';

// Text that reaches exec() or the file system: well-formed Unicode (it has to encode to UTF-8
// unchanged, or the hash would describe bytes that never run) and no NUL byte.
const text = z
  .string()
  .refine((s) => !/\p{Surrogate}/u.test(s), 'must be well-formed Unicode')
  .refine((s) => !s.includes('\0'), 'must not contain a NUL byte');

// zod skips a record key named `__proto__` without an error, so a case would silently lose that
// fixture or variable and share its ID with a different invocation. Refuse the key before parsing.
function withoutProtoKeys<T extends z.ZodType>(schema: T) {
  return z.preprocess((input, ctx) => {
    const walk = (value: unknown, path: PropertyKey[]): void => {
      if (typeof value !== 'object' || value === null) return;
      for (const [key, item] of Object.entries(value)) {
        if (key === '__proto__') ctx.addIssue({ code: 'custom', path: [...path, key], message: '"__proto__" is not supported as a name' });
        else walk(item, [...path, key]);
      }
    };
    walk(input, []);
    return input;
  }, schema);
}

/** Reference to a stored blob: `blob:sha256:<64 hex>`. */
export const BlobRefSchema = z.string().regex(/^blob:sha256:[0-9a-f]{64}$/, 'must be blob:sha256:<64 lowercase hex>');

/** Case ID: the full SHA-256 of the canonical invocation, `sha256:<64 hex>`. Never truncated. */
export const CaseIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 lowercase hex>');

/**
 * Path relative to the case's working directory, in one spelling only: no leading `/`, no empty,
 * `.` or `..` segment. Two spellings of the same file would otherwise give two IDs.
 */
export const RelativePathSchema = text.refine(
  (p) => p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
  'must be a relative path without empty, "." or ".." segments',
);

const EnvNameSchema = text.refine((name) => name !== '' && !name.includes('='), 'must be non-empty and contain no "="');

export const ORIGINS = ['recorded', 'imported', 'generated'] as const;
export const OriginSchema = z.enum(ORIGINS);

/**
 * One invocation of the program under test. `argv` excludes the program name; `stdin: null` means
 * stdin is `/dev/null`; `fixtures` maps paths in the working directory to file contents.
 */
const CaseObjectSchema = z
  .strictObject({
    id: CaseIdSchema.optional(),
    argv: z.array(text),
    stdin: BlobRefSchema.nullable().default(null),
    env: z.record(EnvNameSchema, text).default({}),
    fixtures: z.record(RelativePathSchema, BlobRefSchema).default({}),
    features: z.array(text.min(1)).default([]),
    origin: OriginSchema,
  })
  .superRefine((c, ctx) => {
    const paths = new Set(Object.keys(c.fixtures));
    for (const path of paths) {
      for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
        if (paths.has(path.slice(0, i))) {
          ctx.addIssue({ code: 'custom', path: ['fixtures', path], message: `${path.slice(0, i)} is both a file and a directory` });
        }
      }
    }
  });

export const CaseSchema = withoutProtoKeys(CaseObjectSchema);

export type Case = z.output<typeof CaseObjectSchema>;
export type CaseInput = z.input<typeof CaseObjectSchema>;

/** A case in canonical form: defaults filled in, features sorted and de-duplicated, ID set. */
export type CanonicalCase = Case & { id: string };

/** The fields a case ID covers. `features` and `origin` are metadata about the invocation, not part of it. */
function invocation(c: Case) {
  return { argv: c.argv, stdin: c.stdin, env: c.env, fixtures: c.fixtures };
}

/**
 * Validates a case and returns its canonical form. A case that already carries an ID must carry
 * its own: a mismatch means the case was edited after it was hashed.
 */
export function canonicalCase(input: CaseInput): CanonicalCase {
  const c = CaseSchema.parse(input);
  const id = computeCaseId(c);
  if (c.id !== undefined && c.id !== id) {
    throw new Error(`Case ID ${c.id} does not match its content (expected ${id}).`);
  }
  return { ...c, id, features: [...new Set(c.features)].sort() };
}

/** Full SHA-256 ID of a case: the hash of the canonical JSON of its invocation fields. */
export function caseId(input: CaseInput): string {
  return computeCaseId(CaseSchema.parse(input));
}

function computeCaseId(c: Case): string {
  return `sha256:${createHash('sha256').update(canonicalJson(invocation(c))).digest('hex')}`;
}

/** Canonical JSON of a case, with its ID. Equal cases give byte-identical output. */
export function canonicalCaseJson(input: CaseInput): string {
  return canonicalJson(canonicalCase(input));
}

const ms = z.number().nonnegative();

/** What happened when a program ran a case. `exit` is null exactly when a signal ended the process. */
const ObservationObjectSchema = z
  .strictObject({
    exit: z.int().min(0).max(255).nullable(),
    signal: z.string().regex(/^SIG[A-Z0-9]+$/, 'must be a signal name such as SIGKILL').nullable(),
    timeout: z.boolean(),
    stdout: BlobRefSchema,
    stderr: BlobRefSchema,
    fs: z.strictObject({
      created: z.record(RelativePathSchema, BlobRefSchema),
      modified: z.record(RelativePathSchema, BlobRefSchema),
      deleted: z.array(RelativePathSchema),
    }),
    time_ms: z.strictObject({ wall: ms, user: ms, sys: ms }),
    rss_kb: z.int().nonnegative(),
    runs: z.int().positive(),
    stable: z.boolean(),
  })
  .superRefine((o, ctx) => {
    if ((o.exit === null) === (o.signal === null)) {
      ctx.addIssue({ code: 'custom', path: ['exit'], message: 'exactly one of exit and signal must be set' });
    }
    const seen = new Set<string>();
    for (const path of [...Object.keys(o.fs.created), ...Object.keys(o.fs.modified), ...new Set(o.fs.deleted)]) {
      if (seen.has(path)) ctx.addIssue({ code: 'custom', path: ['fs'], message: `${path} is listed under more than one change` });
      seen.add(path);
    }
  });

export const ObservationSchema = withoutProtoKeys(ObservationObjectSchema);

export type Observation = z.output<typeof ObservationObjectSchema>;

/** Validates an observation and returns its canonical form (deleted paths sorted and de-duplicated). */
export function canonicalObservation(input: unknown): Observation {
  const o = ObservationSchema.parse(input);
  return { ...o, fs: { ...o.fs, deleted: [...new Set(o.fs.deleted)].sort() } };
}

/** Canonical JSON of an observation. Equal observations give byte-identical output. */
export function canonicalObservationJson(input: unknown): string {
  return canonicalJson(canonicalObservation(input));
}

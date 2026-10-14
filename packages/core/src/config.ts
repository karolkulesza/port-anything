import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { DEFAULT_STDERR_SIMILARITY, PROFILES } from './compare.js';
import { NormalizersSchema } from './normalize.js';
import { DEFAULT_TIMEOUT_MS } from './process-runner.js';

const text = z.string().refine((s) => !s.includes('\0'), 'must not contain a NUL byte');

/** A program as `port-anything.yaml` gives it: one string (`'coreutils sort'`) or an argv list. */
const CommandSchema = z.union([text.min(1), z.array(text).min(1)]);

const ProgramSchema = z.strictObject({
  cmd: CommandSchema,
  build: text.optional(),
});

const MAX_DURATION_MS = 2 ** 31 - 1;

/** `10s`, `500ms`, `2m`, or a number of seconds; milliseconds once parsed. */
const DurationSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value) : null;
  const ms = typeof value === 'number' ? value * 1000 : match ? Number(match[1]) * { ms: 1, s: 1000, m: 60_000 }[match[2] as 'ms' | 's' | 'm'] : NaN;
  if (!(ms > 0) || !Number.isFinite(ms)) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive duration such as 10s, 500ms or 2m' });
    return z.NEVER;
  }
  // Node's timers fire after 1 ms for anything longer, so every side would time out at once.
  if (ms > MAX_DURATION_MS) {
    ctx.addIssue({ code: 'custom', message: 'must be at most 35791m (the longest timer Node supports)' });
    return z.NEVER;
  }
  return ms;
});

/** `2x`, `1.5x`, or a plain number: how many times slower than the reference a candidate may run. */
const SlowdownSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)x$/.exec(value) : null;
  const factor = typeof value === 'number' ? value : match ? Number(match[1]) : NaN;
  if (!(factor >= 1) || !Number.isFinite(factor)) {
    ctx.addIssue({ code: 'custom', message: 'must be a factor of at least 1, such as 2x or 1.5x' });
    return z.NEVER;
  }
  return factor;
});

const EnvNameSchema = text.refine((name) => name !== '' && !name.includes('='), 'must be non-empty and contain no "="');

const SandboxSchema = z.strictObject({
  mode: z.enum(['local', 'container']).default('local'),
  image: text.optional(),
  /** In milliseconds once parsed. */
  timeout: DurationSchema.default(DEFAULT_TIMEOUT_MS),
  env_allowlist: z.array(EnvNameSchema).default([]),
  env: z.record(EnvNameSchema, text).default({}),
});

/** Sections read by later commands; accepted here so a config written for them still loads. */
const later = z.unknown().optional();

const CompareSchema = z.strictObject({
  /** Which observation fields count: strict (all), standard (stderr loosely), lenient (exit status and stdout). */
  profile: z.enum(PROFILES).default('standard'),
  fields: z
    .strictObject({
      /** `mode` absent: exact under strict, loose under standard. */
      stderr: z
        .strictObject({
          mode: z.enum(['exact', 'loose']).optional(),
          similarity: z.number().min(0).max(1).default(DEFAULT_STDERR_SIMILARITY),
        })
        .default(() => ({ similarity: DEFAULT_STDERR_SIMILARITY })),
    })
    .default(() => ({ stderr: { similarity: DEFAULT_STDERR_SIMILARITY } })),
  /** Optional gate: the run fails when a candidate's median time ratio is above this factor. */
  max_slowdown: SlowdownSchema.optional(),
  min_parity: later,
});

/** `corpus`: only `min_cases_per_feature` is read so far (by scoring); the other keys are left to later commands. */
const CorpusSchema = z.looseObject({
  /** Features with fewer scored cases are left out of the headline. Default 20. */
  min_cases_per_feature: z.int().min(1).optional(),
});

/** `port-anything.yaml`, after parsing. Unknown keys are errors, so a typo doesn't go unnoticed. */
export const ConfigSchema = z
  .strictObject({
    version: z.literal(1),
    program_name: text
      .refine((name) => name !== '' && name !== '.' && name !== '..' && !name.includes('/'), 'must be a plain file name (no "/", not "." or "..")')
      .optional(),
    reference: ProgramSchema,
    candidate: ProgramSchema.optional(),
    candidates: z.array(ProgramSchema).min(1).optional(),
    sandbox: SandboxSchema.default(() => SandboxSchema.parse({})),
    compare: CompareSchema.default(() => CompareSchema.parse({})),
    /** Applied in order to both sides before comparing. */
    normalizers: NormalizersSchema.default([]),
    corpus: CorpusSchema.optional(),
    holdout: later,
    report: later,
  })
  .refine((c) => c.candidate === undefined || c.candidates === undefined, {
    message: 'use either candidate or candidates, not both',
    path: ['candidates'],
  });

export type Config = z.output<typeof ConfigSchema>;

/** The configured candidates, whichever of `candidate` and `candidates` holds them. */
export function configCandidates(config: Config): z.output<typeof ProgramSchema>[] {
  return config.candidates ?? (config.candidate === undefined ? [] : [config.candidate]);
}

/** Thrown for a config that can't be used; the CLI exits with code 3. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Validates a parsed config, with every problem listed by its key path. */
export function parseConfig(input: unknown, source = 'port-anything.yaml'): Config {
  const result = ConfigSchema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(top level)'}: ${issue.message}`);
  throw new ConfigError([`${source} is not valid:`, ...problems].join('\n'));
}

/** Name of the config file, at the top of the project directory. */
export const CONFIG_FILE = 'port-anything.yaml';

/** Reads and validates the project's `port-anything.yaml`. Every failure is a `ConfigError`. */
export async function readConfigFile(projectDir: string): Promise<Config> {
  let source: string;
  try {
    source = await readFile(join(projectDir, CONFIG_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`No ${CONFIG_FILE} in ${projectDir}.`);
    throw new ConfigError(`Cannot read ${CONFIG_FILE}: ${(e as Error).message}`);
  }
  // YAML 1.2 core schema (no `yes`/`no` booleans); duplicate keys are errors.
  const doc = parseDocument(source, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ConfigError([`${CONFIG_FILE} is not valid YAML:`, ...doc.errors.map((e) => `  ${e.message.replace(/\n/g, '\n  ')}`)].join('\n'));
  }
  return parseConfig(doc.toJS(), CONFIG_FILE);
}

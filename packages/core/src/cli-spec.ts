import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, isScalar, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './config.js';

const text = z.string().refine((s) => !s.includes('\0'), 'must not contain a NUL byte');

/** What a flag value or positional argument holds; `enum` values come with their `choices`. */
export const VALUE_TYPES = ['string', 'int', 'size', 'path', 'enum'] as const;

const ValueSchema = z
  .strictObject({
    /** The placeholder the help text uses (`FILE`, `<n>`). */
    name: text.min(1),
    type: z.enum(VALUE_TYPES),
    choices: z.array(text.min(1)).min(1).optional(),
    /** `--color[=WHEN]`: the flag may be given without it. Only on a flag's single value. */
    optional: z.boolean().optional(),
  })
  .refine((v) => (v.type === 'enum') === (v.choices !== undefined), 'type enum and choices go together');

const FlagNameSchema = text.regex(/^--?[^\s=-][^\s=]*$/, 'must be -x, --long or -long (no spaces, no "=")');

const FlagSchema = z
  .strictObject({
    /** Every spelling of the flag: `[-n, --numeric-sort]`. */
    names: z.array(FlagNameSchema).min(1),
    /** The feature tag cases using this flag get. */
    feature: text.min(1),
    description: text.optional(),
    /** Number of values the flag takes (`--arg name value` takes 2). */
    arity: z.number().int().min(0),
    values: z.array(ValueSchema).default([]),
    /** `--help`, `--version` and the like: scored apart from the headline. */
    self_description: z.boolean().optional(),
  })
  .refine((f) => f.values.length === f.arity, { message: 'arity must equal the number of values', path: ['arity'] })
  .refine((f) => f.values.every((v, i) => !v.optional || (i === 0 && f.arity === 1)), {
    message: 'only a flag with a single value can make it optional',
    path: ['values'],
  });

/** How many times a positional argument appears: once, maybe once, any number, at least once. */
export const POSITIONAL_ARITIES = ['1', '?', '*', '+'] as const;

const PositionalSchema = z.strictObject({
  name: text.min(1),
  type: z.enum(VALUE_TYPES),
  arity: z.enum(POSITIONAL_ARITIES),
});

/** One way to call the program, from one usage line: the flags it requires and its positionals. */
const FormSchema = z.strictObject({
  usage: text,
  flags: z.array(FlagNameSchema).default([]),
  args: z.array(PositionalSchema).default([]),
});

interface CommandShape {
  flags: z.output<typeof FlagSchema>[];
  forms: z.output<typeof FormSchema>[];
  subcommands: SubcommandOutput[];
}
interface SubcommandOutput extends CommandShape {
  name: string;
  feature: string;
  description?: string | undefined;
  self_description?: boolean | undefined;
}

const SubcommandSchema: z.ZodType<SubcommandOutput, unknown> = z.lazy(() =>
  z.strictObject({
    name: text.regex(/^[^\s-][^\s]*$/, 'must be one word, not starting with "-"'),
    feature: text.min(1),
    description: text.optional(),
    self_description: z.boolean().optional(),
    flags: z.array(FlagSchema).default([]),
    forms: z.array(FormSchema).default([]),
    subcommands: z.array(SubcommandSchema).default([]),
  }),
);

/**
 * `port-anything/cli-spec.yaml`: the program's grammar (flags, positional forms, subcommands) and
 * the feature tags it defines. A heuristic `--help` parse writes the first version; people and
 * agents refine it. Every feature tag must be unique.
 */
export const CliSpecSchema = z
  .strictObject({
    version: z.literal(1),
    program: text.min(1),
    flags: z.array(FlagSchema).default([]),
    forms: z.array(FormSchema).default([]),
    subcommands: z.array(SubcommandSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const feature of specFeatures(spec)) {
      if (seen.has(feature.name)) ctx.addIssue({ code: 'custom', message: `feature ${feature.name} is defined more than once`, path: ['flags'] });
      seen.add(feature.name);
    }
  });

export type CliSpec = z.output<typeof CliSpecSchema>;
export type CliFlag = z.output<typeof FlagSchema>;
export type CliValue = z.output<typeof ValueSchema>;
export type CliPositional = z.output<typeof PositionalSchema>;
export type CliForm = z.output<typeof FormSchema>;
export type CliSubcommand = SubcommandOutput;

/** A feature the spec defines, and whether it is a self-description feature (left out of the headline). */
export interface SpecFeature {
  name: string;
  selfDescription: boolean;
}

/** Every feature tag the spec defines: one per flag and per subcommand, depth first. */
export function specFeatures(spec: CommandShape): SpecFeature[] {
  const out: SpecFeature[] = [];
  const walk = (command: CommandShape) => {
    for (const flag of command.flags) out.push({ name: flag.feature, selfDescription: flag.self_description === true });
    for (const sub of command.subcommands) {
      out.push({ name: sub.feature, selfDescription: sub.self_description === true });
      walk(sub);
    }
  };
  walk(spec);
  return out;
}

/** Where the CLI spec lives in a project. */
export const CLI_SPEC_FILE = 'port-anything/cli-spec.yaml';

/** Validates a parsed CLI spec, with every problem listed by its key path. */
export function parseCliSpec(input: unknown, source = CLI_SPEC_FILE): CliSpec {
  const result = CliSpecSchema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(top level)'}: ${issue.message}`);
  throw new ConfigError([`${source} is not valid:`, ...problems].join('\n'));
}

/** Reads and validates `port-anything/cli-spec.yaml`. Every failure is a `ConfigError`. */
export async function readCliSpecFile(projectDir: string): Promise<CliSpec> {
  let source: string;
  try {
    source = await readFile(join(projectDir, CLI_SPEC_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`No ${CLI_SPEC_FILE} in ${projectDir}.`);
    throw new ConfigError(`Cannot read ${CLI_SPEC_FILE}: ${(e as Error).message}`);
  }
  const doc = parseDocument(source, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ConfigError([`${CLI_SPEC_FILE} is not valid YAML:`, ...doc.errors.map((e) => `  ${e.message.replace(/\n/g, '\n  ')}`)].join('\n'));
  }
  return parseCliSpec(doc.toJS(), CLI_SPEC_FILE);
}

/**
 * The spec as YAML: keys in schema order, empty lists and unset keys left out, lists of plain
 * values on one line (`names: [-n, --numeric-sort]`).
 */
export function cliSpecYaml(spec: CliSpec): string {
  const doc = new Document(compact(parseCliSpec(spec)));
  visit(doc, {
    Seq(_, node) {
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0 });
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0 && key !== 'names')) continue;
    out[key] = compact(v);
  }
  return out;
}

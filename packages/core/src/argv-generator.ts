import { blobRef } from './blob-store.js';
import type { CliFlag, CliForm, CliPositional, CliSpec, CliSubcommand, CliValue } from './cli-spec.js';
import { assertNotDestructive, destructiveSubcommand } from './destructive.js';
import { canonicalCase, type CanonicalCase } from './model.js';
import { createRng, type GeneratorVersion, type Rng } from './rng.js';
import { UNKNOWN_LONG_FLAG } from './spec-probe.js';

// Everything below is part of generator v1: changing a pool, an order or a draw changes the cases
// a committed corpus regenerates to. Changes go into a new generator version instead.

/** How a generated case came about. */
export type ArgvStrategy = 'form' | 'flag' | 'pairwise' | 'invalid';

export interface GeneratedCase {
  case: CanonicalCase;
  strategy: ArgvStrategy;
}

export interface GeneratedArgv {
  /** In generation order, without duplicates (by case ID). */
  cases: GeneratedCase[];
  /** Contents of every stdin and fixture blob the cases reference, by blob ref. */
  blobs: Map<string, Uint8Array>;
  /** Destructive subcommands left out because `iKnow` wasn't set (`git push`). */
  skipped: string[];
}

export interface GenerateArgvOptions {
  seed: string | number;
  generator: GeneratorVersion;
  /** Generate for a denylisted tool or subcommand anyway (`--i-know`). */
  iKnow?: boolean;
}

/** A path value and the files it needs in the case's directory. */
interface PathValue {
  value: string;
  files: string[];
}

const SAMPLE_INPUTS: readonly string[] = [
  'b\na\nc\n',
  '3\n1\n2\n10\n-1\n',
  'hello world\nfoo bar baz\n\nlast line\n',
  'no trailing newline',
  'ünïcödé\n日本語\nemoji ✓\n',
  '  leading\ttab\nmixed CASE\n',
  '{"a":1,"b":[1,2,3],"c":"x"}\n',
  'a,b,c\n1,2,3\n',
  '',
];

const EMPTY_FILE = 'empty.txt';

// Every path is relative to the case's directory and stays inside it.
const PATHS = {
  input: { value: 'input.txt', files: ['input.txt'] },
  data: { value: 'data.txt', files: ['data.txt'] },
  spaces: { value: 'dir with spaces/file name.txt', files: ['dir with spaces/file name.txt'] },
  dir: { value: 'dir with spaces', files: ['dir with spaces/file name.txt'] },
  unicode: { value: 'ünïcödé.txt', files: ['ünïcödé.txt'] },
  empty: { value: EMPTY_FILE, files: [EMPTY_FILE] },
  missing: { value: 'missing.txt', files: [] },
  blank: { value: '', files: [] },
} satisfies Record<string, PathValue>;

type Kind = CliValue['type'];

/** Values a well-formed call uses (forms, pairwise, the other values of a multi-value flag). */
const VALID: Record<Exclude<Kind, 'enum' | 'path'>, readonly string[]> = {
  string: ['a', 'hello', 'hello world'],
  int: ['1', '2', '10'],
  size: ['1', '10', '1K'],
};
const VALID_PATHS: readonly PathValue[] = [PATHS.input, PATHS.data];

/** Boundary values, one single-flag case each: empty, 0, -1, huge, unicode, paths with spaces. */
const BOUNDARY: Record<Exclude<Kind, 'enum' | 'path'>, readonly string[]> = {
  string: ['', 'a', 'hello world', '-', 'ünïcödé ✓ 日本語', 'x'.repeat(4096)],
  int: ['0', '1', '-1', '2147483648', '18446744073709551616', ''],
  size: ['0', '1', '-1', '1K', '1M', '18446744073709551616', ''],
};
const BOUNDARY_PATHS: readonly PathValue[] = [PATHS.input, PATHS.spaces, PATHS.dir, PATHS.unicode, PATHS.empty, PATHS.missing, PATHS.blank];

/** Values the type rules out, for the error paths. */
const INVALID: Record<Kind, readonly string[]> = {
  string: [],
  path: [],
  int: ['abc', '1.5'],
  size: ['abc', '1Q'],
  enum: ['port-anything-invalid'],
};

// Letters tried, rarest first, for a one-letter flag the spec doesn't list.
const SHORT_CANDIDATES = 'QZJYKGWXBEHIOPURTVLMNSDFACqzjykgwxbehiopurtvlmnsdfac';

/** Cases drawn per positional form. */
const FORM_VARIANTS = 3;
/** Random rows scored per pairwise row; the best one is kept. */
const PAIRWISE_CANDIDATES = 16;

/**
 * True when an argv token can't name anything outside the case's directory. The token and every
 * part of it a tool might read as a path (what follows each `=`, as in `--of=k=/x`, and the value
 * of a short flag written attached, `-o/x`) must not start with `/` or `~`, and no `..` may stand
 * between separators (`/`, `\`, `=`).
 */
export function isSafeArgvToken(token: string): boolean {
  const parts = [token];
  for (let i = token.indexOf('='); i !== -1; i = token.indexOf('=', i + 1)) parts.push(token.slice(i + 1));
  if (/^-[^-]/.test(token)) parts.push(token.slice(2));
  return parts.every((part) => !/^[/~]/.test(part) && !part.split(/[/\\=]/).includes('..'));
}

/**
 * Generator v1: cases for every command of the spec, from
 * - each positional form (a few draws of argument counts and values);
 * - each flag alone, once per boundary value of each of its values;
 * - a pairwise covering set of the command's flags (every two flags seen on/off in all four ways);
 * - invalid calls: unknown flags, a missing value, values the type rules out, missing positionals.
 *
 * Every generated path is relative and inside the case's directory, and the fixtures those paths
 * need are part of the case. The output depends only on the spec, the seed and the generator
 * version. Refuses a denylisted tool (`DestructiveToolError`) and leaves out denylisted
 * subcommands, unless `iKnow` is set.
 */
export function generateArgvCases(spec: CliSpec, options: GenerateArgvOptions): GeneratedArgv {
  const rng = createRng(options.seed, options.generator);
  assertNotDestructive([spec.program], options);
  const out: GeneratedArgv = { cases: [], blobs: new Map(), skipped: [] };
  const seen = new Set<string>();
  const builder = new CaseBuilder(rng, out, seen);

  const walk = (command: Command, path: string[], features: string[]) => {
    generateCommand(builder, rng, command, path, features);
    for (const sub of command.subcommands) {
      if (!isSafeArgvToken(sub.name)) continue;
      const subPath = [...path, sub.name];
      if (options.iKnow !== true && destructiveSubcommand(spec.program, subPath) !== null) {
        out.skipped.push([spec.program, ...subPath].join(' '));
        continue;
      }
      walk(sub, subPath, [...features, sub.feature]);
    }
  };
  walk(spec, [], []);
  return out;
}

type Command = Pick<CliSubcommand, 'flags' | 'forms' | 'subcommands'>;

/** A flag as it appears in one case: its spelling and its values. */
interface FlagUse {
  flag: CliFlag;
  values: (string | PathValue)[];
}

function generateCommand(builder: CaseBuilder, rng: Rng, command: Command, path: string[], features: string[]): void {
  const flags = command.flags.filter((f) => f.names.some(isSafeArgvToken));
  const byName = new Map(flags.flatMap((f) => f.names.map((n) => [n, f] as const)));
  const forms = command.forms.length > 0 ? command.forms : [{ usage: '', flags: [], args: [] }];
  const requiredUses = (form: CliForm): FlagUse[] =>
    form.flags.flatMap((name) => {
      const flag = byName.get(name);
      return flag === undefined ? [] : [{ flag, values: flag.values.map((v) => validValue(rng, v)) }];
    });
  // Flag cases start from the first form that needs no flag of its own.
  const baseForm = forms.find((f) => f.flags.length === 0) ?? forms[0]!;
  const baseArgs = () => positionals(rng, baseForm.args);
  const emit = (strategy: ArgvStrategy, uses: FlagUse[], args: (string | PathValue)[], extra: string[] = [], tags: string[] = []) =>
    builder.add(strategy, path, features, [...requiredUses(baseForm), ...uses], args, extra, tags);

  for (const form of forms) {
    for (let i = 0; i < FORM_VARIANTS; i++) {
      builder.add('form', path, features, requiredUses(form), positionals(rng, form.args), []);
    }
  }

  for (const flag of flags) {
    if (flag.arity === 0) {
      emit('flag', [{ flag, values: [] }], baseArgs());
      continue;
    }
    if (flag.values[0]!.optional === true) emit('flag', [{ flag, values: [] }], baseArgs());
    flag.values.forEach((value, i) => {
      for (const boundary of boundaryValues(value)) {
        const values = flag.values.map((v, j) => (j === i ? boundary : validValue(rng, v)));
        emit('flag', [{ flag, values }], baseArgs());
      }
    });
  }

  const required = new Set(baseForm.flags);
  const pairable = flags.filter((f) => f.self_description !== true && !f.names.some((n) => required.has(n)));
  for (const row of pairwiseRows(rng, pairable.length)) {
    const uses = pairable.filter((_, i) => row[i]).map((flag) => ({ flag, values: flag.values.map((v) => validValue(rng, v)) }));
    emit('pairwise', uses, baseArgs());
  }

  emit('invalid', [], baseArgs(), [UNKNOWN_LONG_FLAG]);
  const letters = new Set(flags.flatMap((f) => f.names).filter((n) => /^-[^-]$/.test(n)).map((n) => n[1]));
  const unknownShort = [...SHORT_CANDIDATES].find((c) => !letters.has(c));
  if (unknownShort !== undefined) emit('invalid', [], baseArgs(), [`-${unknownShort}`]);
  for (const flag of flags) {
    if (flag.arity === 0) continue;
    if (flag.values[0]!.optional !== true) {
      // The flag last, with nothing after it to take as its value.
      emit('invalid', [], baseArgs(), [spelling(rng, flag)], [flag.feature]);
    }
    flag.values.forEach((value, i) => {
      for (const bad of INVALID[value.type]) {
        const values = flag.values.map((v, j) => (j === i ? bad : validValue(rng, v)));
        emit('invalid', [{ flag, values }], baseArgs());
      }
    });
  }
  for (const form of forms) {
    if (form.args.some((a) => a.arity === '1' || a.arity === '+')) {
      builder.add('invalid', path, features, requiredUses(form), [], []);
    }
  }
}

function positionals(rng: Rng, args: CliPositional[]): (string | PathValue)[] {
  const out: (string | PathValue)[] = [];
  for (const arg of args) {
    const count = arg.arity === '1' ? 1 : arg.arity === '?' ? rng.int(2) : arg.arity === '*' ? rng.int(3) : 1 + rng.int(2);
    for (let i = 0; i < count; i++) out.push(validValue(rng, arg));
  }
  return out;
}

function safeChoices(value: Pick<CliValue, 'choices'>): string[] {
  return (value.choices ?? []).filter(isSafeArgvToken);
}

function validValue(rng: Rng, value: Pick<CliValue, 'type' | 'choices'>): string | PathValue {
  if (value.type === 'path') return rng.pick(VALID_PATHS);
  if (value.type === 'enum') {
    const choices = safeChoices(value);
    return choices.length > 0 ? rng.pick(choices) : rng.pick(VALID.string);
  }
  return rng.pick(VALID[value.type]);
}

function boundaryValues(value: CliValue): (string | PathValue)[] {
  if (value.type === 'path') return [...BOUNDARY_PATHS];
  if (value.type === 'enum') return safeChoices(value);
  return [...BOUNDARY[value.type]];
}

function spelling(rng: Rng, flag: CliFlag): string {
  return rng.pick(flag.names.filter(isSafeArgvToken));
}

/**
 * Rows of a binary covering array of strength 2 over `n` flags: for every two flags, each of
 * on/on, on/off, off/on and off/off appears in some row. Greedy: of a few random rows, keep the
 * one covering the most pairs not yet covered.
 */
function pairwiseRows(rng: Rng, n: number): boolean[][] {
  if (n < 2) return [];
  const uncovered = new Set<number>();
  const key = (i: number, j: number, a: boolean, b: boolean) => ((i * n + j) * 2 + (a ? 1 : 0)) * 2 + (b ? 1 : 0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) for (const a of [false, true]) for (const b of [false, true]) uncovered.add(key(i, j, a, b));
  }
  const covers = (row: boolean[]) => {
    const keys: number[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (uncovered.has(key(i, j, row[i]!, row[j]!))) keys.push(key(i, j, row[i]!, row[j]!));
    return keys;
  };
  const rows: boolean[][] = [];
  while (uncovered.size > 0) {
    let best: boolean[] = [];
    let bestKeys: number[] = [];
    for (let c = 0; c < PAIRWISE_CANDIDATES; c++) {
      const row = Array.from({ length: n }, () => rng.int(2) === 1);
      const keys = covers(row);
      if (keys.length > bestKeys.length) [best, bestKeys] = [row, keys];
    }
    if (bestKeys.length === 0) {
      // No random row helped: build one around the first pair still missing.
      const first = uncovered.values().next().value!;
      const b = first % 2 === 1, a = Math.floor(first / 2) % 2 === 1, ij = Math.floor(first / 4);
      best = Array.from({ length: n }, () => rng.int(2) === 1);
      best[Math.floor(ij / n)] = a;
      best[ij % n] = b;
      bestKeys = covers(best);
    }
    for (const k of bestKeys) uncovered.delete(k);
    rows.push(best);
  }
  return rows;
}

/** Turns flag uses and positionals into canonical cases with their fixtures and stdin. */
class CaseBuilder {
  constructor(
    private readonly rng: Rng,
    private readonly out: GeneratedArgv,
    private readonly seen: Set<string>,
  ) {}

  add(strategy: ArgvStrategy, path: string[], features: string[], uses: FlagUse[], args: (string | PathValue)[], extra: string[], tags: string[] = []): void {
    const files = new Set<string>();
    const text = (v: string | PathValue) => {
      if (typeof v === 'string') return v;
      for (const file of v.files) files.add(file);
      return v.value;
    };
    const argv = [...path];
    for (const use of uses) argv.push(...this.flagTokens(use.flag, use.values).map(text));
    argv.push(...extra, ...args.map(text));
    if (!argv.every(isSafeArgvToken)) throw new Error(`generator produced an unsafe argv: ${JSON.stringify(argv)}`);

    const fixtures: Record<string, string> = {};
    for (const file of [...files].sort()) fixtures[file] = this.blob(file === EMPTY_FILE ? '' : this.rng.pick(SAMPLE_INPUTS));
    const stdin = this.blob(this.rng.pick(SAMPLE_INPUTS));
    const flagFeatures = uses.map((u) => u.flag.feature);
    const base = uses.length === 0 && extra.length === 0 ? ['base'] : [];
    const c = canonicalCase({ argv, stdin, fixtures, features: [...features, ...flagFeatures, ...tags, ...base], origin: 'generated' });
    if (this.seen.has(c.id)) return;
    this.seen.add(c.id);
    this.out.cases.push({ case: c, strategy });
  }

  private blob(content: string): string {
    const bytes = new TextEncoder().encode(content);
    const ref = blobRef(bytes);
    if (!this.out.blobs.has(ref)) this.out.blobs.set(ref, bytes);
    return ref;
  }

  /**
   * `--name=value` or `--name value`, `-xvalue` or `-x value`; an optional value is always
   * attached, or left out where it can't be. Path values stay whole so only used files get made.
   */
  private flagTokens(flag: CliFlag, values: (string | PathValue)[]): (string | PathValue)[] {
    const name = spelling(this.rng, flag);
    if (values.length === 0) return [name];
    const long = name.startsWith('--');
    const short = /^-[^-]$/.test(name);
    const optional = flag.values[0]!.optional === true;
    if (values.length === 1 && (long || short)) {
      const value = values[0]!;
      const valueText = typeof value === 'string' ? value : value.value;
      const attached = optional || this.rng.int(2) === 1;
      const join = (sep: string): PathValue => ({ value: `${name}${sep}${valueText}`, files: typeof value === 'string' ? [] : value.files });
      if (attached && long) return [join('=')];
      // An empty value attached to a short flag would be the bare flag.
      if (attached && short && valueText !== '' && !valueText.startsWith('-')) return [join('')];
      if (optional) return [name];
    }
    return [name, ...values];
  }
}

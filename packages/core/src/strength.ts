import { createHash } from 'node:crypto';
import { extname } from 'node:path';

/** Mutants `port-anything strength` tests by default; each costs a build and a corpus run. */
export const DEFAULT_STRENGTH_MUTANTS = 200;

/**
 * What became of one mutant: `caught` when the corpus saw a difference, `missed` when it didn't,
 * `timeout` when the mutation tool gave up on its test, `unviable` when it didn't build.
 */
export type MutantStatus = 'caught' | 'missed' | 'timeout' | 'unviable';

export interface MutantResult {
  /** As the mutation tool names it, e.g. `src/main.rs:101:26: replace += with *= in count`. */
  name: string;
  status: MutantStatus;
}

/** The corpus's mutation score against a candidate. */
export interface StrengthScore {
  /** Mutants tested, unviable ones included. */
  mutants: number;
  caught: number;
  missed: number;
  timeout: number;
  unviable: number;
  /** caught / (caught + missed + timeout), to 4 decimals; null when no mutant built. */
  score: number | null;
  /** Missed and timed-out mutants, sorted: behavior the corpus doesn't test. */
  survivors: string[];
  /** Sorted. */
  caught_mutants: string[];
}

/**
 * Scores mutation results: the share of the mutants that built which the corpus caught. A mutant
 * that timed out counts as surviving, since nothing in the corpus told it apart.
 */
export function scoreMutants(results: readonly MutantResult[]): StrengthScore {
  const named = (status: MutantStatus) => results.filter((r) => r.status === status).map((r) => r.name);
  const [caught, missed, timeout, unviable] = (['caught', 'missed', 'timeout', 'unviable'] as const).map(named) as [string[], string[], string[], string[]];
  const counted = caught.length + missed.length + timeout.length;
  return {
    mutants: results.length,
    caught: caught.length,
    missed: missed.length,
    timeout: timeout.length,
    unviable: unviable.length,
    score: counted === 0 ? null : Math.round((caught.length / counted) * 10_000) / 10_000,
    survivors: [...missed, ...timeout].sort(),
    caught_mutants: caught.sort(),
  };
}

/**
 * Picks up to `count` mutants, in their original order. The pick depends only on each name (the
 * ones with the lowest SHA-256 of their name), so a run repeats the last one's sample, and adding
 * code keeps the mutants already picked unless new ones rank before them.
 */
export function sampleMutants(names: readonly string[], count: number): string[] {
  if (names.length <= count) return [...names];
  const hash = (name: string) => createHash('sha256').update(name).digest('hex');
  const picked = new Set(
    names
      .map((name) => ({ name, key: hash(name) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, count)
      .map((m) => m.name),
  );
  return names.filter((name) => picked.has(name));
}

/**
 * Reads a mutation-testing-elements report (Stryker's JSON reporter, mull's Elements reporter).
 * Killed is caught; Survived and NoCoverage are missed; Timeout is timeout; CompileError and
 * RuntimeError are unviable; Ignored and Pending mutants are left out.
 */
export function parseElementsReport(report: unknown): MutantResult[] {
  const files = (report as { files?: unknown } | null)?.files;
  if (files === null || typeof files !== 'object') throw new Error('The mutation report has no "files" object.');
  const results: MutantResult[] = [];
  for (const [file, entry] of Object.entries(files as Record<string, { mutants?: unknown }>)) {
    if (!Array.isArray(entry?.mutants)) throw new Error(`The mutation report lists no mutants array for ${file}.`);
    for (const m of entry.mutants as ElementsMutant[]) {
      const status = ELEMENTS_STATUS[m.status];
      if (status === undefined) {
        if (m.status === 'Ignored' || m.status === 'Pending') continue;
        throw new Error(`Unknown mutant status "${String(m.status)}" in the mutation report.`);
      }
      const at = `${file}:${m.location.start.line}:${m.location.start.column}`;
      const change = m.replacement === undefined ? m.mutatorName : `${m.mutatorName}, replace with ${oneLine(m.replacement)}`;
      results.push({ name: `${at}: ${change}`, status });
    }
  }
  return results;
}

interface ElementsMutant {
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number } };
}

const ELEMENTS_STATUS: Record<string, MutantStatus> = {
  Killed: 'caught',
  Survived: 'missed',
  NoCoverage: 'missed',
  Timeout: 'timeout',
  CompileError: 'unviable',
  RuntimeError: 'unviable',
};

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
};

/** One change the generic fallback makes to a source file. */
export interface SourceMutant {
  /** `<file>:<line>:<column>: replace <original> with <replacement>`, lines and columns from 1. */
  name: string;
  file: string;
  /** Offset into the file's text, in UTF-16 code units. */
  offset: number;
  original: string;
  replacement: string;
}

type Syntax = 'c' | 'hash' | 'lua';

/** Source languages the generic fallback mutates, by extension. */
const SYNTAX: Record<string, Syntax> = Object.fromEntries([
  ...['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx', '.m', '.mm'].map((e) => [e, 'c']),
  ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].map((e) => [e, 'c']),
  ...['.go', '.java', '.kt', '.kts', '.scala', '.swift', '.cs', '.dart', '.zig', '.rs', '.d', '.v'].map((e) => [e, 'c']),
  ...['.py', '.rb', '.pl', '.pm', '.r', '.jl', '.cr', '.nim', '.ex', '.exs'].map((e) => [e, 'hash']),
  ...['.lua'].map((e) => [e, 'lua']),
]);

/** Whether the generic fallback mutates this file (by its extension). */
export function isMutableSource(path: string): boolean {
  return SYNTAX[extname(path).toLowerCase()] !== undefined;
}

// Operators and their replacements, longest first so `<=` is never read as `<`.
const OPERATORS: readonly (readonly [string, readonly string[]])[] = [
  ['===', ['!==']],
  ['!==', ['===']],
  ['==', ['!=']],
  ['!=', ['==']],
  ['<=', ['<']],
  ['>=', ['>']],
  ['&&', ['||']],
  ['||', ['&&']],
  ['+=', ['-=']],
  ['-=', ['+=']],
  ['<', ['<=']],
  ['>', ['>=']],
  ['+', ['-']],
  ['-', ['+']],
  ['!', ['']],
];
// Operator characters; a run of them that isn't one operator above (`<<`, `->`, `++`) is left alone.
const OPERATOR_CHARS = /[=!<>&|+\-*/%^~?:]/;

const WORDS: Record<Syntax, Record<string, readonly string[]>> = {
  c: { true: ['false'], false: ['true'] },
  hash: { True: ['False'], False: ['True'], true: ['false'], false: ['true'], and: ['or'], or: ['and'] },
  lua: { true: ['false'], false: ['true'], and: ['or'], or: ['and'] },
};

/**
 * The generic fallback's mutants of a source file: comparison, logic and arithmetic operators
 * swapped, `!` deleted, boolean words flipped, decimal integers changed (0 → 1, n → n + 1). Strings,
 * comments and preprocessor lines are left alone. A mutant that no longer compiles is expected;
 * it counts as unviable.
 */
export function sourceMutants(file: string, text: string): SourceMutant[] {
  const syntax = SYNTAX[extname(file).toLowerCase()];
  if (syntax === undefined) return [];
  const mutants: SourceMutant[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const add = (offset: number, original: string, replacements: readonly string[]) => {
    let line = lineStarts.length - 1;
    while (lineStarts[line]! > offset) line--;
    const column = offset - lineStarts[line]! + 1;
    for (const replacement of replacements) {
      const change = replacement === '' ? `delete ${original}` : `replace ${original} with ${replacement}`;
      mutants.push({ name: `${file}:${line + 1}:${column}: ${change}`, file, offset, original, replacement });
    }
  };

  // The last significant token before the current one: whether `+`/`-` can be binary.
  let previous: 'operand' | 'other' = 'other';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = (n: number) => text.slice(i, i + n);
    const lineStart = i === 0 || text[i - 1] === '\n';
    // Whitespace.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // Preprocessor lines (C family) and shebangs: skip to the end of the line, with continuations.
    if (syntax === 'c' && ch === '#' && /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) {
      i = endOfLine(text, i, true);
      previous = 'other';
      continue;
    }
    if (lineStart && rest(2) === '#!') {
      i = endOfLine(text, i, false);
      continue;
    }
    // Comments.
    if ((syntax === 'c' && rest(2) === '//') || (syntax === 'hash' && ch === '#') || (syntax === 'lua' && rest(2) === '--' && rest(4) !== '--[[')) {
      i = endOfLine(text, i, false);
      continue;
    }
    if (syntax === 'c' && rest(2) === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (syntax === 'lua' && (rest(4) === '--[[' || rest(2) === '[[')) {
      const end = text.indexOf(']]', i);
      i = end === -1 ? text.length : end + 2;
      previous = 'operand';
      continue;
    }
    // Strings and character literals.
    if (syntax === 'hash' && (rest(3) === '"""' || rest(3) === "'''")) {
      const end = text.indexOf(rest(3), i + 3);
      i = end === -1 ? text.length : end + 3;
      previous = 'operand';
      continue;
    }
    if (ch === '"' || ch === '`' || (ch === "'" && !(extname(file) === '.rs' && isRustLifetime(text, i)))) {
      i = endOfString(text, i, ch);
      previous = 'operand';
      continue;
    }
    // Words: identifiers, keywords and numbers.
    const word = /^[A-Za-z_$][\w$]*|^\d[\w.]*/.exec(text.slice(i, i + 200))?.[0];
    if (word !== undefined) {
      const replacements = WORDS[syntax][word];
      if (replacements !== undefined) add(i, word, replacements);
      else if (/^\d+$/.test(word) && !(word.length > 1 && word.startsWith('0')) && text[i - 1] !== '.') {
        add(i, word, [String(BigInt(word) + 1n)]);
      }
      i += word.length;
      previous = 'operand';
      continue;
    }
    // Operators.
    if (OPERATOR_CHARS.test(ch)) {
      let end = i;
      while (end < text.length && OPERATOR_CHARS.test(text[end]!)) end++;
      const run = text.slice(i, end);
      const op = OPERATORS.find(([o]) => o === run);
      if (op !== undefined && mutable(op[0], previous, text, end)) add(i, op[0], op[1]);
      i = end;
      previous = 'other';
      continue;
    }
    previous = ch === ')' || ch === ']' ? 'operand' : 'other';
    i++;
  }
  return mutants;
}

/** Whether an operator is mutated where it stands: `+`/`-` only between operands, `!` only as `!x`. */
function mutable(op: string, previous: 'operand' | 'other', text: string, end: number): boolean {
  if (op === '+' || op === '-') return previous === 'operand';
  if (op === '!') return previous === 'other' && /[\w(!]/.test(text[end] ?? '');
  return true;
}

function endOfLine(text: string, i: number, continuations: boolean): number {
  for (;;) {
    const end = text.indexOf('\n', i);
    if (end === -1) return text.length;
    if (!continuations || text[end - 1] !== '\\') return end;
    i = end + 1;
  }
}

function endOfString(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
    else if (text[i] === '\n' && quote !== '`') return i + 1; // unterminated on its line: stop there
  }
  return text.length;
}

/** `'a` in `&'a str` is a Rust lifetime, not a character literal. */
function isRustLifetime(text: string, i: number): boolean {
  return !/^'(\\.[^']*|[^'\\])'/.test(text.slice(i, i + 12));
}

/** The source with one mutant applied. */
export function applyMutant(text: string, mutant: SourceMutant): string {
  if (text.slice(mutant.offset, mutant.offset + mutant.original.length) !== mutant.original) {
    throw new Error(`${mutant.name}: the source no longer has "${mutant.original}" there.`);
  }
  return text.slice(0, mutant.offset) + mutant.replacement + text.slice(mutant.offset + mutant.original.length);
}

import { CliSpecSchema, type CliFlag, type CliForm, type CliPositional, type CliSpec, type CliSubcommand, type CliValue } from './cli-spec.js';

/** A flag as one help text describes it, before it gets a feature tag. */
export interface HelpFlag {
  names: string[];
  description?: string;
  values: CliValue[];
}

/** What a heuristic read of one `--help` output found. */
export interface ParsedHelp {
  /** The program name the usage line gives, if there is one. */
  program?: string;
  flags: HelpFlag[];
  forms: CliForm[];
  subcommands: { name: string; description?: string }[];
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OPTION_LINE = /^--?[A-Za-z0-9?#@]/;
const OPTION_PLACEHOLDER = /^(options?|flags?|opts?|switches)$/i;
const CHOICE = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/**
 * Reads a program's `--help` output: the usage lines (one positional form each), the option lines
 * (GNU, clap, argparse, Go, busybox and toybox layouts), the value placeholders and their choices
 * where the text lists them, and a commands section if there is one. A heuristic: it reads what
 * the text shows and guesses nothing it doesn't, so the result is a first draft to refine.
 */
export function parseHelp(raw: string, options: { program?: string } = {}): ParsedHelp {
  // Control characters other than tabs and newlines (NUL, stray escapes) carry nothing to read.
  const lines = raw
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split('\n');
  const usage = readUsage(lines, options.program);
  const program = options.program ?? usage.program;
  const body = readOptionLines(lines, usage.lines);
  const flags: HelpFlag[] = [];
  for (const flag of body.flags) mergeFlag(flags, flag, 'body');
  const forms: CliForm[] = [];
  for (const text of usage.forms) {
    const { form, flags: usageFlags } = readForm(text, program);
    forms.push(form);
    for (const flag of usageFlags) mergeFlag(flags, flag, 'usage');
  }
  const prose = paragraphs(lines.filter((_, i) => !usage.lines.has(i) && !body.lines.has(i)));
  for (const flag of flags) addChoices(flag, prose);
  const subcommands = readCommands(lines, new Set([...usage.lines, ...body.lines]));
  return { ...(program === undefined ? {} : { program }), flags, forms, subcommands };
}

// ---------------------------------------------------------------------------------------------
// Usage lines

function readUsage(lines: string[], program: string | undefined): { program?: string; forms: string[]; lines: Set<number> } {
  const used = new Set<number>();
  const start = lines.findIndex((l) => /^\s*usage:/i.test(l));
  if (start < 0) return { forms: [], lines: used };
  used.add(start);
  const forms: string[] = [];
  const first = lines[start]!.replace(/^\s*usage:\s*/i, '').trim();
  if (first !== '') forms.push(first);
  const name = program ?? (first === '' ? firstWord(lines[start + 1] ?? '') : firstWord(first));
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // An option line right under the usage (curl) ends it; a usage line goes on with `[`, `{`, `<`.
    if (line.trim() === '' || !/^\s/.test(line) || (OPTION_LINE.test(line.trim()) && /\t| {2,}/.test(line.trim()))) break;
    used.add(i);
    const text = line.trim();
    const or = /^or:\s*(.*)$/i.exec(text);
    if (or) forms.push(or[1]!.trim());
    else if (forms.length === 0 || (name !== undefined && sameProgram(firstWord(text), name))) forms.push(text);
    else forms[forms.length - 1] += ` ${text}`;
  }
  const found = name ?? (forms[0] === undefined ? undefined : firstWord(forms[0]));
  return { ...(found === undefined ? {} : { program: basename(found) }), forms, lines: used };
}

const firstWord = (text: string): string => text.trim().split(/\s+/)[0] ?? '';
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const sameProgram = (word: string, program: string): boolean => word !== '' && basename(word) === basename(program);

type Token = { t: 'open' | 'close'; ch: string } | { t: 'bar' } | { t: 'dots' } | { t: 'word'; text: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) i++;
    else if (text.startsWith('...', i)) (tokens.push({ t: 'dots' }), (i += 3));
    else if (ch === '…') (tokens.push({ t: 'dots' }), i++);
    else if ('[{('.includes(ch)) (tokens.push({ t: 'open', ch }), i++);
    else if (']})'.includes(ch)) (tokens.push({ t: 'close', ch }), i++);
    else if (ch === '|') (tokens.push({ t: 'bar' }), i++);
    else {
      // A word runs to whitespace at bracket depth 0; brackets attached to it (`--color[=WHEN]`,
      // `N[,M]`, `<jq filter>`) belong to it.
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        const c = text[j]!;
        if ('[<{'.includes(c) && (j > i || c === '<')) depth++;
        else if (']>}'.includes(c)) {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (/\s/.test(c) || c === '|' || text.startsWith('...', j) || c === '…' || (c === '(' && j > i))) break;
      }
      if (j === i) j++; // a stray character; keep moving
      tokens.push({ t: 'word', text: text.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

type UsageNode = { kind: 'word'; text: string; repeat: boolean } | { kind: 'group'; optional: boolean; alts: UsageNode[][]; repeat: boolean };

function parseNodes(tokens: Token[]): UsageNode[][] {
  let pos = 0;
  const seq = (closer: string | undefined): UsageNode[][] => {
    const alts: UsageNode[][] = [[]];
    while (pos < tokens.length) {
      const tok = tokens[pos++]!;
      const current = alts[alts.length - 1]!;
      if (tok.t === 'close') {
        if (closer !== undefined) return alts; // a mismatched closer still ends the group
        continue;
      }
      if (tok.t === 'bar') alts.push([]);
      else if (tok.t === 'dots') {
        const last = current[current.length - 1];
        if (last) last.repeat = true;
      } else if (tok.t === 'open') {
        const close = { '[': ']', '{': '}', '(': ')' }[tok.ch]!;
        current.push({ kind: 'group', optional: tok.ch === '[', alts: seq(close), repeat: false });
      } else if (tok.t === 'word') {
        let text = tok.text;
        let repeat = false;
        if (text.endsWith('...')) (text = text.slice(0, -3)), (repeat = true);
        if (text !== '') current.push({ kind: 'word', text, repeat });
      }
    }
    return alts;
  };
  return seq(undefined);
}

/** One usage line as a form, plus every flag the line mentions. */
function readForm(text: string, program: string | undefined): { form: CliForm; flags: HelpFlag[] } {
  const usage = text.replace(/\s+/g, ' ').trim();
  const tokens = tokenize(usage);
  const head = tokens[0];
  if (head?.t === 'word' && (program === undefined ? !head.text.startsWith('-') : sameProgram(head.text, program))) tokens.shift();
  const flags: HelpFlag[] = [];
  const form: CliForm = { usage, flags: [], args: [] };
  const top = parseNodes(tokens);
  for (const [n, alt] of top.entries()) walk(alt, { optional: false, repeat: false, positionals: n === 0, required: n === 0 && top.length === 1 });
  return { form, flags };

  function walk(nodes: UsageNode[], ctx: { optional: boolean; repeat: boolean; positionals: boolean; required: boolean }): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.kind === 'group') {
        const single = node.alts.length === 1;
        const aliases = aliasPair(node.alts);
        if (aliases) {
          flags.push({ names: aliases, values: [] });
          continue;
        }
        for (const alt of node.alts) {
          walk(alt, {
            optional: ctx.optional || node.optional,
            repeat: ctx.repeat || node.repeat,
            positionals: ctx.positionals && single && node.kind === 'group' && node.optional,
            required: ctx.required && single && !node.optional,
          });
        }
        continue;
      }
      const word = node.text;
      if (word === '--' || word === '-') continue;
      if (word.startsWith('-') && word.length > 1) {
        const cluster = shortCluster(word);
        if (cluster) {
          for (const name of cluster) flags.push({ names: [name], values: [] });
          continue;
        }
        // `-Olevel`: a flag with its value attached; `-depth` (all lowercase) is a flag's name.
        const attached = /^(-[A-Z])([a-z]{2,})$/.exec(word);
        const item = attached ? { name: attached[1]!, values: [valueFor(attached[2]!)] } : parseFlagItem(word, false);
        if (!item) continue;
        // `[-o FILE]`: words after the first flag of an optional group are its values.
        if (ctx.optional && i === 0) {
          while (i + 1 < nodes.length && nodes[i + 1]!.kind === 'word' && !(nodes[i + 1] as { text: string }).text.startsWith('-')) {
            const value = nodes[++i] as { text: string };
            item.values.push(valueFor(value.text));
          }
        }
        flags.push({ names: [item.name], values: item.values });
        if (ctx.required && !('literal' in item && item.literal !== undefined)) form.flags.push(item.name);
        continue;
      }
      const bare = stripMeta(word) || 'ARG'; // `<...>` names nothing
      if (OPTION_PLACEHOLDER.test(bare) || /^\[?options?\]?$/i.test(word)) continue;
      if (!ctx.positionals) continue;
      const repeat = ctx.repeat || node.repeat;
      const arity: CliPositional['arity'] = ctx.optional ? (repeat ? '*' : '?') : repeat ? '+' : '1';
      form.args.push({ name: bare, type: valueType(bare), arity });
    }
  }
}

/** `[-v | --version]`: a short and a long flag offered as alternatives are one flag. */
function aliasPair(alts: UsageNode[][]): string[] | undefined {
  if (alts.length !== 2) return undefined;
  const names = alts.map((alt) => (alt.length === 1 && alt[0]!.kind === 'word' ? alt[0]!.text : ''));
  const [a, b] = names as [string, string];
  if (/^-[A-Za-z0-9?]$/.test(a) && /^--[A-Za-z0-9][\w-]*$/.test(b)) return [a, b];
  if (/^-[A-Za-z0-9?]$/.test(b) && /^--[A-Za-z0-9][\w-]*$/.test(a)) return [b, a];
  return undefined;
}

/**
 * `-cmlwL` or `-c[dfwzZ]` in a usage line: several one-letter flags written together. A letter may
 * repeat next to itself (`-ff`, a flag given twice); `-Olevel` is a flag and its value instead.
 */
function shortCluster(word: string): string[] | undefined {
  const m = /^-([A-Za-z0-9]+)(?:\[([A-Za-z0-9]+)\])?$/.exec(word);
  if (!m || (m[1]!.length < 2 && m[2] === undefined)) return undefined;
  const letters = (m[1]! + (m[2] ?? '')).replace(/(.)\1+/g, '$1');
  if (new Set(letters).size !== letters.length) return undefined;
  return [...letters].map((c) => `-${c}`);
}

// ---------------------------------------------------------------------------------------------
// Option lines

interface FlagItem {
  name: string;
  values: CliValue[];
  /** `--check=quiet`: the item names one value of the flag rather than a placeholder. */
  literal?: string;
}

function readOptionLines(lines: string[], skip: Set<number>): { flags: HelpFlag[]; lines: Set<number> } {
  const used = new Set<number>();
  const raw = lines.map((line, i) => (!skip.has(i) && OPTION_LINE.test(line.trim()) ? i : -1)).filter((i) => i >= 0);
  const column = descriptionColumn(raw.map((i) => lines[i]!));
  // A line starting with a flag as deep as the descriptions continues one (`--diff, --extract or …`).
  const isOption = new Set(raw.filter((i) => column === undefined || expandTabs(lines[i]!).search(/\S/) < column));
  const flags: HelpFlag[] = [];
  for (const i of isOption) {
    if (used.has(i)) continue;
    used.add(i);
    let line = lines[i]!;
    let last = i;
    // `--color[=WHEN],` with `--colour[=WHEN]  …` on the next line: one entry.
    while (line.trimEnd().endsWith(',') && last + 1 < lines.length && OPTION_LINE.test(lines[last + 1]!.trim())) {
      line = `${line.trimEnd()} ${lines[++last]!.trim()}`;
      used.add(last);
    }
    const indent = expandTabs(line).search(/\S/);
    let { spec, description, lenient } = splitOptionLine(line, column);
    const items: FlagItem[] = [];
    const parts = spec.split(/,\s*(?=-)|\s+\|\s+(?=-)/);
    for (const [n, part] of parts.entries()) {
      // Another spelling follows, so everything up to it is this one's placeholders (`-e script, …`).
      const item = parseFlagItem(part.trim(), lenient || n < parts.length - 1);
      if (!item) break;
      items.push(item);
      if (item.rest !== '') {
        // Words the item didn't take start the description (`-k N[,M] Sort by Nth field`).
        description = [item.rest, ...parts.slice(n + 1), description].filter((s) => s !== '').join(' ');
        break;
      }
    }
    // `--expression=script` next to `-e script` is a placeholder; it names a value only when the
    // flag is already known (`-c, --check, --check=diagnose-first`).
    for (const item of items) {
      if (item.literal === undefined) continue;
      if (items.some((o) => o.name === item.name && o.literal === undefined) || flags.some((f) => f.names.includes(item.name))) continue;
      item.values = [valueFor(item.literal)];
      delete item.literal;
    }
    if (items.length === 0) continue;
    const continuation: string[] = [];
    for (let j = last + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === '' || isOption.has(j) || expandTabs(next).search(/\S/) <= indent) break;
      used.add(j);
      continuation.push(next.trim());
    }
    const text = [description, ...continuation].filter((s) => s !== '').join(' ');
    // `--check=quiet` names a value of `--check` (on this line or an earlier one), not a flag of its own.
    const own = items.filter((item) => item.literal === undefined);
    const ownNames = new Set(own.map((item) => item.name));
    const values = own.reduce<CliValue[]>((best, item) => (item.values.length > best.length ? item.values : best), []);
    const flag: HelpFlag = { names: [...ownNames], values, ...(text === '' ? {} : { description: text }) };
    for (const item of items) {
      if (item.literal === undefined) continue;
      const target = ownNames.has(item.name) ? flag : flags.find((f) => f.names.includes(item.name));
      if (target) addLiteral(target, item.literal);
    }
    if (flag.names.length === 0) continue;
    choicesFromDescription(flag);
    mergeFlag(flags, flag, 'body');
  }
  return { flags, lines: used };
}

/** `-c, --check, --check=diagnose-first`: the flag's value becomes optional, with this choice. */
function addLiteral(flag: HelpFlag, literal: string): void {
  if (flag.values.length === 0) {
    const name = (flag.names.find((n) => n.startsWith('--')) ?? flag.names[0]!).replace(/^-+/, '').toUpperCase();
    flag.values = [{ name, type: 'enum', choices: [literal], optional: true }];
  } else if (flag.values.length === 1 && flag.values[0]!.type === 'enum') {
    const value = flag.values[0]!;
    flag.values = [{ ...value, choices: [...new Set([...value.choices!, literal])] }];
  }
}

/** The column most option descriptions start at (where an option line's text after a gap begins). */
function descriptionColumn(lines: string[]): number | undefined {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const expanded = expandTabs(line);
    const m = /^(\s*\S+(?: \S+)*?)( {2,})\S/.exec(expanded);
    if (m) counts.set(m[1]!.length + m[2]!.length, (counts.get(m[1]!.length + m[2]!.length) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [col, n] of counts) if (best === undefined || n > counts.get(best)! || (n === counts.get(best)! && col < best)) best = col;
  return best;
}

/** Splits an option line at the gap (a tab or two spaces) before its description. */
function splitOptionLine(line: string, column: number | undefined): { spec: string; description: string; lenient: boolean } {
  const trimmed = line.trim();
  const gap = /\t+| {2,}/.exec(trimmed);
  if (gap) {
    let spec = trimmed.slice(0, gap.index);
    let description = trimmed.slice(gap.index + gap[0].length).trim();
    // `--arg       <A> <V>   Set variable`: placeholders aligned in a column of their own.
    for (let m = /^(<[^>]*>)\s*/.exec(description); m; m = /^(<[^>]*>)\s*/.exec(description)) {
      spec += ` ${m[1]}`;
      description = description.slice(m[0].length);
    }
    return { spec, description, lenient: true };
  }
  const expanded = expandTabs(line);
  const indent = expanded.search(/\S/);
  if (column !== undefined && column > indent && expanded.length > column && expanded[column - 1] === ' ' && expanded[column] !== ' ') {
    return { spec: expanded.slice(indent, column).trim(), description: expanded.slice(column).trim(), lenient: true };
  }
  return { spec: trimmed, description: '', lenient: false };
}

/**
 * One flag spelling with its placeholders: `-k`, `--key=KEYDEF`, `--color[=WHEN]`, `-L=`,
 * `--arg name value`, `--from <FORMAT>`, `-o FILE`. `lenient` also takes lowercase placeholders,
 * which is safe only when the description was split off by a gap. Words that aren't placeholders
 * are left in `rest`.
 */
function parseFlagItem(text: string, lenient: boolean): (FlagItem & { rest: string }) | undefined {
  const m = /^(--?[A-Za-z0-9?#@][\w.#@+-]*)(.*)$/s.exec(text);
  if (!m) return undefined;
  let name = m[1]!;
  let rest = m[2]!;
  // `-k2,4` or `-k2.4` in prose is an example, not a flag; `-name` and `-print0` are flags (find).
  // `-NUM` stands for a number written as a flag (`-5`), not a flag named NUM.
  if (/^-[A-Za-z][\d.,]/.test(name) || /^-[A-Z]{2,}$/.test(name) || (rest !== '' && !/^[\s=[]/.test(rest))) return undefined;
  const values: CliValue[] = [];
  let literal: string | undefined;
  // `-k#`: a placeholder written into the name.
  if (/^-[A-Za-z0-9]#$/.test(name)) {
    const tail = /^\S*/.exec(rest)![0];
    values.push({ name: `#${tail}`, type: tail === '' ? 'int' : 'string' });
    (name = name.slice(0, 2)), (rest = rest.slice(tail.length));
  } else if (rest.startsWith('[')) {
    const end = closing(rest, 0);
    const inner = rest.slice(1, end).replace(/^=/, '');
    rest = rest.slice(end + 1);
    values.push({ ...valueFor(inner), optional: true });
  } else if (rest.startsWith('=')) {
    const word = /^=(\S*)/.exec(rest)![1]!;
    rest = rest.slice(word.length + 1);
    if (word === '') values.push({ name: name.replace(/^-+/, '').toUpperCase(), type: 'string' });
    else if (/^[a-z0-9][a-z0-9-]*$/.test(word) && name.startsWith('--')) literal = word;
    else values.push(valueFor(word));
  }
  if (/^\S/.test(rest)) return { name, values, rest: rest.trim(), ...(literal === undefined ? {} : { literal }) };
  let words = rest.trim();
  while (words !== '') {
    const w = /^(<[^>]*>(?:\.\.\.)?|\{[^}]*\}|\S+)\s*/.exec(words)!;
    const word = w[1]!;
    const placeholder = word.startsWith('<') || word.startsWith('{') || /^[A-Z#][^a-z\s]*$/.test(word) || (lenient && /^[a-z][a-z0-9_-]*$/.test(word));
    if (!placeholder || values.some((v) => v.optional)) break;
    values.push(valueFor(word));
    words = words.slice(w[0].length);
  }
  return { name, values, rest: words, ...(literal === undefined ? {} : { literal }) };
}

function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i;
  }
  return text.length;
}

/** A placeholder as a value: `FILE`, `<n>`, `{a,b}` and `<a|b>` (choices), `KEYDEF...`. */
function valueFor(word: string): CliValue {
  const inner = word.replace(/\.\.\.$/, '');
  const braces = /^\{([^}]*)\}$/.exec(inner);
  const angle = /^<([^>]*)>$/.exec(inner);
  const options = braces ? braces[1]!.split(',') : angle && angle[1]!.includes('|') ? angle[1]!.split('|') : undefined;
  if (options && options.length > 1 && options.every((o) => CHOICE.test(o.trim()))) {
    return { name: inner, type: 'enum', choices: options.map((o) => o.trim()) };
  }
  const name = stripMeta(inner);
  return { name: name === '' ? 'VALUE' : name, type: valueType(name) };
}

const stripMeta = (word: string): string => word.replace(/^<([^<>]*)>$/, '$1').replace(/^\[(.*)\]$/, '$1').replace(/\.\.\.$/, '');

/** A placeholder's type from its name: files and directories, counts, sizes, else text. */
export function valueType(name: string): CliValue['type'] {
  const n = name.replace(/[<>[\]{}=.]/g, '');
  if (/^(files?|filenames?|dirs?|director(y|ies)|paths?|pathnames?)$/i.test(n) || /(file|dir|path)s?$/i.test(n)) return 'path';
  if (/^(n|num|number|count|width|cols|columns|level|levels|depth|pid|uid|gid|fd|strsize|nmerge|#)$/i.test(n) || /^(n|num|max|min)[_-]\w+$/i.test(n)) return 'int';
  if (/^(size|bytes)$/i.test(n)) return 'size';
  return 'string';
}

// ---------------------------------------------------------------------------------------------
// Choices

/** `[possible values: a, b]` (clap) and `WHEN can be: a, b` or `FMT='a', 'b'` (GNU) in a description. */
function choicesFromDescription(flag: HelpFlag): void {
  const value = flag.values.length === 1 ? flag.values[0]! : undefined;
  if (!value || value.type === 'enum' || flag.description === undefined) return;
  const clap = /\[possible values: ([^\]]*)\]/.exec(flag.description);
  const choices = clap ? listChoices(clap[1]!) : choicesNear(flag.description, value.name);
  if (choices) flag.values = [{ ...value, type: 'enum', choices }];
}

function addChoices(flag: HelpFlag, prose: string[]): void {
  const value = flag.values.length === 1 ? flag.values[0]! : undefined;
  if (!value || value.type !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(value.name)) return;
  for (const paragraph of prose) {
    for (const sentence of paragraph.split(/(?<=[.;])\s+(?=[A-Z])/)) {
      if (!new RegExp(`\\b${value.name}\\b`).test(sentence) || !/can (also )?be|is one of|argument|may be/.test(sentence)) continue;
      const choices = choicesNear(sentence, value.name);
      if (choices) {
        flag.values = [{ ...value, type: 'enum', choices }];
        return;
      }
    }
  }
}

/** Choices in the text after a placeholder's name: quoted words, else a list after `:` or `can be`. */
function choicesNear(text: string, placeholder: string): string[] | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]+$/.test(placeholder) || valueType(placeholder) !== 'string') return undefined;
  const at = new RegExp(`\\b${placeholder}\\b`).exec(text);
  if (!at) return undefined;
  const after = text.slice(at.index + placeholder.length);
  const sentence = after.split(/(?<=\.)\s+(?=[A-Z])/)[0]!;
  const quoted = [...sentence.matchAll(/['`‘]([^'`’\s]+)['’]/g)].map((m) => m[1]!);
  if (quoted.length >= 2) return quoted.every((q) => CHOICE.test(q)) ? [...new Set(quoted)] : undefined;
  const list = /(?::\s|can (?:also )?be:?|is one of:?)\s*([^;]*)/.exec(sentence);
  return list ? listChoices(list[1]!.replace(/\.$/, '')) : undefined;
}

/** `a, b (default), or c -x`: the first word of each item, if every item starts with a plain word. */
function listChoices(text: string): string[] | undefined {
  const items = text
    .split(/,\s*(?:or\s+)?|\s+or\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // Items are a word with at most a short note (`month -M`) or a remark in brackets, not prose.
  if (items.some((s) => s.replace(/\([^)]*\)/g, '').trim().split(/\s+/).length > 3)) return undefined;
  const words = items.map((s) => s.split(/\s+/)[0]!);
  if (words.length < 2 || !words.every((w) => CHOICE.test(w))) return undefined;
  return [...new Set(words)];
}

function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) out.push(current.join(' '));
      current = [];
    } else current.push(line.trim());
  }
  if (current.length > 0) out.push(current.join(' '));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Commands

/** A section whose heading mentions commands, with `  name   description` entries. */
function readCommands(lines: string[], skip: Set<number>): { name: string; description?: string }[] {
  const commands: { name: string; description?: string }[] = [];
  let inSection = false;
  for (const [i, line] of lines.entries()) {
    if (skip.has(i) || line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      if (/\bcommands?\b/i.test(line)) inSection = true;
      else if (/:\s*$/.test(line) || /\boptions?\b/i.test(line)) inSection = false;
      continue;
    }
    if (!inSection) continue;
    const m = /^\s+([a-z][a-z0-9_-]*)(?:\t+| {2,})(\S.*)?$/.exec(line) ?? /^\s+([a-z][a-z0-9_-]*)$/.exec(line);
    if (!m || commands.some((c) => c.name === m[1])) continue;
    commands.push({ name: m[1]!, ...(m[2] === undefined ? {} : { description: m[2].trim() }) });
  }
  return commands;
}

// ---------------------------------------------------------------------------------------------
// Merging

/**
 * Adds a flag, or merges it into the flag sharing a name. Values from the body win; a usage line
 * adds values only to a flag the body lists without any (toybox lists `-o` and shows `-o FILE`
 * only in its usage line).
 */
function mergeFlag(flags: HelpFlag[], flag: HelpFlag, from: 'body' | 'usage'): void {
  const existing = flags.find((f) => f.names.some((n) => flag.names.includes(n)));
  if (!existing) {
    flags.push({ ...flag, names: [...flag.names], values: [...flag.values] });
    return;
  }
  existing.names = [...new Set([...existing.names, ...flag.names])];
  if (existing.values.length === 0 && flag.values.length > 0) existing.values = [...flag.values];
  else if (from === 'body' && existing.values.length === 1 && flag.values.length === 1) {
    const [a, b] = [existing.values[0]!, flag.values[0]!];
    if (a.type === 'enum' && b.type === 'enum') existing.values = [{ ...a, choices: [...new Set([...a.choices!, ...b.choices!])] }];
  }
  if (existing.description === undefined && flag.description !== undefined) existing.description = flag.description;
}

function expandTabs(line: string): string {
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(8 - (out.length % 8)) : ch;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Spec

const SELF_DESCRIPTION_NAMES = new Set(['--help', '--version', '--usage', '-?']);

/** Whether a flag only describes the program (help, version, usage) rather than exercising it. */
export function isSelfDescription(flag: Pick<HelpFlag, 'names' | 'description'>): boolean {
  if (flag.names.some((n) => SELF_DESCRIPTION_NAMES.has(n))) return true;
  if (flag.names.some((n) => n.startsWith('--'))) return false;
  return /^(display|show|print|output|give)s?\b[^.;]*\b(help|usage|version)\b/i.test(flag.description ?? '');
}

/**
 * The CLI spec for a program from its `--help` and, for each subcommand, that subcommand's
 * `--help` (missing ones keep only their name). Each flag gets the feature `opt.<long name>`
 * (or `opt.<letter>`), each subcommand `cmd.<name>`, with its flags under `cmd.<name>.opt.…`.
 */
export function cliSpecFromHelp(program: string, help: ParsedHelp, subcommandHelp: Readonly<Record<string, ParsedHelp>> = {}): CliSpec {
  const used = new Set<string>();
  const feature = (base: string): string => {
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  };
  const flagsOf = (parsed: ParsedHelp, prefix: string): CliFlag[] =>
    parsed.flags.map((f) => ({
      names: f.names,
      feature: feature(`${prefix}opt.${primaryName(f.names)}`),
      ...(f.description === undefined ? {} : { description: f.description }),
      arity: f.values.length,
      values: f.values.map((v) => cleanValue(v, f.values.length)),
      ...(isSelfDescription(f) ? { self_description: true } : {}),
    }));
  const subcommands: CliSubcommand[] = help.subcommands.map((s) => {
    const own = Object.hasOwn(subcommandHelp, s.name) ? subcommandHelp[s.name] : undefined;
    const prefix = `cmd.${s.name}.`;
    return {
      name: s.name,
      feature: feature(`cmd.${s.name}`),
      ...(s.description === undefined ? {} : { description: s.description }),
      ...(s.name === 'help' ? { self_description: true } : {}),
      flags: own ? flagsOf(own, prefix) : [],
      // `frob make [-f] NAME`: the subcommand's own name isn't one of its arguments.
      forms: (own?.forms ?? []).map((f) => (f.args[0]?.name === s.name && f.args[0].arity === '1' ? { ...f, args: f.args.slice(1) } : f)),
      subcommands: [],
    };
  });
  return CliSpecSchema.parse({ version: 1, program, flags: flagsOf(help, ''), forms: help.forms, subcommands });
}

function primaryName(names: readonly string[]): string {
  const name = names.find((n) => n.startsWith('--')) ?? names.find((n) => n.length > 2) ?? names[0]!;
  return name.replace(/^-+/, '');
}

/** Keeps a value valid in the spec: no empty choice list, `optional` only on a flag's single value. */
function cleanValue(value: CliValue, count: number): CliValue {
  const { choices, optional, ...rest } = value;
  const keepChoices = value.type === 'enum' && choices !== undefined && choices.length > 0;
  return {
    ...rest,
    type: value.type === 'enum' && !keepChoices ? 'string' : value.type,
    ...(keepChoices ? { choices } : {}),
    ...(optional && count === 1 ? { optional } : {}),
  };
}

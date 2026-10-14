/**
 * Kinds of token the generic lexer knows. It is not a parser for any one language: it splits text
 * the way most filter, query and config languages agree on, so whole-token mutation keeps most
 * inputs well-formed.
 */
export const TOKEN_KINDS = ['space', 'word', 'number', 'string', 'flag', 'operator', 'delimiter'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Multi-character operators recognized by default, matched longest first. */
const OPERATORS = ['?//=', '//=', '?//', '...', '|=', '+=', '-=', '*=', '/=', '%=', '//', '==', '!=', '<=', '>=', '&&', '||', '->', '=>', '::', ':=', '<<', '>>', '..', '**'];
const DELIMITERS = new Set(['(', ')', '[', ']', '{', '}', ',', ';', ':']);

const SPACE = /\s+/y;
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/sy;
const FLAG = /--?[A-Za-z][A-Za-z0-9_-]*/y;
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[$@]?[\p{L}_][\p{L}\p{N}_]*|[$@]/uy;

function match(re: RegExp, text: string, at: number): string | undefined {
  re.lastIndex = at;
  return re.exec(text)?.[0];
}

/**
 * Splits text into tokens; joining the tokens' text gives the input back exactly. A flag
 * (`-x`, `--long`) is only recognized at the start or after whitespace, so `a-b` stays three tokens.
 * An unterminated quote is a one-character operator, and lexing goes on after it.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const prev = tokens.at(-1);
    let token: Token;
    let m: string | undefined;
    if ((m = match(SPACE, text, at))) token = { kind: 'space', text: m };
    else if ((m = match(STRING, text, at))) token = { kind: 'string', text: m };
    else if ((prev === undefined || prev.kind === 'space') && (m = match(FLAG, text, at))) token = { kind: 'flag', text: m };
    else if ((m = match(NUMBER, text, at))) token = { kind: 'number', text: m };
    else if ((m = match(WORD, text, at))) token = { kind: 'word', text: m };
    else if ((m = OPERATORS.find((op) => text.startsWith(op, at)))) token = { kind: 'operator', text: m };
    else {
      m = String.fromCodePoint(text.codePointAt(at)!);
      token = { kind: DELIMITERS.has(m) ? 'delimiter' : 'operator', text: m };
    }
    tokens.push(token);
    at += token.text.length;
  }
  return tokens;
}

/** Tokens known to a generator, de-duplicated and sorted per kind so the order never depends on input order. */
export interface TokenDictionary {
  /** Every non-space kind that has at least one token, in `TOKEN_KINDS` order. */
  kinds: readonly TokenKind[];
  byKind: ReadonlyMap<TokenKind, readonly string[]>;
  size: number;
}

export interface DictionarySources {
  /** Output of the program's `--help`. */
  help?: string;
  /** The man page, as troff source or as rendered plain text. */
  man?: string;
  /** Seed inputs (filters, documents, argv values); every token in them is kept. */
  seeds?: readonly string[];
}

/**
 * Builds a token dictionary from help text, the man page and seeds. Seeds give all their tokens.
 * Help and man pages are mostly prose, so only the parts that look like code are taken: flags,
 * flag value choices (`{auto,always,never}`, `[a|b]`), backtick spans, `$ ` example lines, and in
 * troff, `.nf`/`.EX` blocks and bold text. Inside code, single-quoted spans are shell quoting, so
 * their content is lexed instead of the quoted string.
 */
export function buildTokenDictionary(sources: DictionarySources): TokenDictionary {
  const sets = new Map<TokenKind, Set<string>>();
  const add = (token: Token) => {
    if (token.kind === 'space') return;
    let set = sets.get(token.kind);
    if (!set) sets.set(token.kind, (set = new Set()));
    set.add(token.text);
  };

  for (const seed of sources.seeds ?? []) tokenize(seed).forEach(add);
  for (const doc of [sources.help, sources.man]) {
    if (doc === undefined) continue;
    const { prose, code } = isTroff(doc) ? fromTroff(doc) : fromPlainText(doc);
    for (const flag of prose.matchAll(/(?<![\w-])--?[A-Za-z][A-Za-z0-9_-]*/g)) add({ kind: 'flag', text: flag[0] });
    for (const choice of prose.matchAll(/[{[(]([\w.-]+(?:[,|][\w.-]+)+)[}\])]/g)) {
      for (const value of choice[1]!.split(/[,|]/)) tokenize(value).forEach(add);
    }
    for (const line of code) codeTokens(line).forEach(add);
  }

  const byKind = new Map<TokenKind, readonly string[]>();
  let size = 0;
  for (const kind of TOKEN_KINDS) {
    const set = sets.get(kind);
    if (!set) continue;
    const sorted = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    byKind.set(kind, sorted);
    size += sorted.length;
  }
  return { kinds: [...byKind.keys()], byKind, size };
}

function codeTokens(line: string): Token[] {
  if (!/'[^']*'/.test(line)) return tokenize(line);
  const tokens: Token[] = [];
  const outside = line.replace(/'([^']*)'/g, (_, inner: string) => {
    tokens.push(...tokenize(inner));
    return ' ';
  });
  return [...tokens, ...tokenize(outside)];
}

function fromPlainText(doc: string): { prose: string; code: string[] } {
  const code: string[] = [];
  for (const span of doc.matchAll(/`([^`\n]+)`/g)) code.push(span[1]!);
  for (const example of doc.matchAll(/^\s*\$ (.+)$/gm)) code.push(example[1]!);
  return { prose: doc, code };
}

function isTroff(doc: string): boolean {
  return /^\.(?:TH|SH|Dd|Dt)\b/m.test(doc);
}

function fromTroff(doc: string): { prose: string; code: string[] } {
  const prose: string[] = [];
  const code: string[] = [];
  let inBlock = false;
  for (const raw of doc.split('\n')) {
    if (raw.startsWith('.\\"') || raw.startsWith("'\\\"")) continue;
    const macro = /^\.([A-Za-z]{1,2})\b\s*(.*)$/.exec(raw);
    if (macro) {
      const [, name, args] = macro as unknown as [string, string, string];
      if (name === 'nf' || name === 'EX') inBlock = true;
      else if (name === 'fi' || name === 'EE') inBlock = false;
      else if (name === 'B' || name === 'BR' || name === 'BI' || name === 'Fl' || name === 'Cm') {
        const text = unescapeTroff(args.replace(/^"(.*)"$/, '$1'));
        code.push(name === 'Fl' ? `-${text}` : text);
        prose.push(name === 'Fl' ? `-${text}` : text);
      } else prose.push(unescapeTroff(args));
      continue;
    }
    for (const bold of raw.matchAll(/\\f(?:B|\(CB|\[B\]|\[CB\])(.*?)\\f(?:R|P|\[\]|\[R\])/g)) code.push(unescapeTroff(bold[1]!));
    const text = unescapeTroff(raw);
    if (inBlock) code.push(text);
    prose.push(text);
  }
  return { prose: prose.join('\n'), code };
}

const TROFF_CHARS: Record<string, string> = { aq: "'", dq: '"', em: '-', en: '-', ga: '`', ti: '~', ha: '^', rs: '\\', lq: '"', rq: '"', oq: "'", cq: "'", bu: '' };

function unescapeTroff(s: string): string {
  return s
    .replace(/\\f(?:\[[^\]]*\]|\(..|.)/g, '')
    .replace(/\\\((..)/g, (_, name: string) => TROFF_CHARS[name] ?? '')
    .replace(/\\\[(\w+)\]/g, (_, name: string) => TROFF_CHARS[name] ?? '')
    .replace(/\\(.)/g, (_, c: string) => (c === 'e' ? '\\' : '&|^c'.includes(c) ? '' : c));
}

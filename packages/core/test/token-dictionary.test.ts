import { describe, expect, it } from 'vitest';
import { buildTokenDictionary, tokenize, type Token } from '../src/token-dictionary.js';

const kinds = (text: string) => tokenize(text).filter((t) => t.kind !== 'space').map((t) => `${t.kind}:${t.text}`);

describe('tokenize', () => {
  it('splits a filter into whole tokens', () => {
    expect(kinds('.items[] | select(.n >= 10) // "none"')).toEqual([
      'operator:.', 'word:items', 'delimiter:[', 'delimiter:]', 'operator:|', 'word:select', 'delimiter:(',
      'operator:.', 'word:n', 'operator:>=', 'number:10', 'delimiter:)', 'operator://', 'string:"none"',
    ]);
  });

  it('keeps strings with escapes, $variables, @formats and exponents whole', () => {
    expect(kinds(String.raw`$x | @base64 + "a \"b\" \(.c)" + 1.5e-3`)).toEqual([
      'word:$x', 'operator:|', 'word:@base64', 'operator:+', String.raw`string:"a \"b\" \(.c)"`, 'operator:+', 'number:1.5e-3',
    ]);
  });

  it('recognizes flags only at the start or after whitespace', () => {
    expect(kinds('--sort-keys -r a-b')).toEqual(['flag:--sort-keys', 'flag:-r', 'word:a', 'operator:-', 'word:b']);
  });

  it('treats an unterminated quote as a one-character operator', () => {
    expect(kinds('"abc')).toEqual(['operator:"', 'word:abc']);
  });

  it('gives the input back when the tokens are joined', () => {
    for (const text of ['', '  a  ', 'déjà-vu → 𝔘 ∘ x', '{"a": [1, 2.5, null]}', 'if . then "x\n" else empty end', '\'shell\' "q']) {
      expect(tokenize(text).map((t) => t.text).join('')).toBe(text);
    }
  });
});

describe('buildTokenDictionary', () => {
  it('keeps every non-space token of the seeds, sorted and de-duplicated per kind', () => {
    const d = buildTokenDictionary({ seeds: ['.b | .a', '.a + 1'] });
    expect(d.byKind.get('word')).toEqual(['a', 'b']);
    expect(d.byKind.get('operator')).toEqual(['+', '.', '|']);
    expect(d.byKind.get('number')).toEqual(['1']);
    expect(d.kinds).toEqual(['word', 'number', 'operator']);
    expect(d.size).toBe(6);
  });

  it('does not depend on the order of the seeds', () => {
    const a = buildTokenDictionary({ seeds: ['.x | length', 'keys[0]', '"s"'] });
    const b = buildTokenDictionary({ seeds: ['"s"', 'keys[0]', '.x | length'] });
    expect([...b.byKind]).toEqual([...a.byKind]);
  });

  it('takes flags, flag value choices, backtick spans and $ examples from --help, not prose words', () => {
    const help = [
      'Usage: tool [OPTIONS] FILTER [FILES...]',
      '',
      'Process the input with the given filter.',
      '',
      '  -r, --raw-output        print strings without quotes',
      '      --color=WHEN        colorize output: {auto,always,never}',
      '      --indent n          use `n` spaces; `0` turns indentation off',
      '',
      'Example:',
      "  $ tool '.a | keys' input.json",
    ].join('\n');
    const d = buildTokenDictionary({ help });
    expect(d.byKind.get('flag')).toEqual(['--color', '--indent', '--raw-output', '-r']);
    expect(d.byKind.get('word')).toEqual(expect.arrayContaining(['auto', 'always', 'never', 'n', 'keys', 'a', 'tool', 'input', 'json']));
    expect(d.byKind.get('word')).not.toContain('Process');
    expect(d.byKind.get('word')).not.toContain('print');
    expect(d.byKind.get('number')).toEqual(['0']);
    expect(d.byKind.get('operator')).toEqual(expect.arrayContaining(['.', '|']));
    expect(d.byKind.get('string')).toBeUndefined(); // the shell quotes around the filter are not a string token
  });

  it('takes code blocks, bold text and flags from a troff man page and unescapes them', () => {
    const man = [
      '.\\" a comment with \\fBnotbold\\fR',
      '.TH TOOL 1',
      '.SH NAME',
      'tool \\- process input',
      '.SH OPTIONS',
      '.TP',
      '.B \\-\\-slurp',
      'Read every input into one array.',
      '.TP',
      'Use \\fBlength\\fR or \\fBascii_downcase\\fR to inspect values.',
      '.SH EXAMPLES',
      '.nf',
      "tool \\(aq.[] | select(.id == 2)\\(aq",
      '{"id": 2}',
      '.fi',
      'Afterwards plain prose again.',
    ].join('\n');
    const d = buildTokenDictionary({ man });
    expect(d.byKind.get('flag')).toEqual(['--slurp']);
    const words = d.byKind.get('word');
    expect(words).toEqual(expect.arrayContaining(['length', 'ascii_downcase', 'select', 'id', 'tool']));
    expect(words).not.toContain('notbold');
    expect(words).not.toContain('Afterwards');
    expect(d.byKind.get('operator')).toEqual(expect.arrayContaining(['.', '|', '==']));
    expect(d.byKind.get('string')).toEqual(['"id"']);
    expect(d.byKind.get('number')).toEqual(['2']);
  });

  it('reads a rendered (plain text) man page like help text', () => {
    const d = buildTokenDictionary({ man: 'OPTIONS\n     -S, --sort-keys\n          Output the fields of each object with the keys in sorted order.' });
    expect(d.byKind.get('flag')).toEqual(['--sort-keys', '-S']);
    expect(d.byKind.get('word')).toBeUndefined();
  });

  it('is empty without sources', () => {
    const d = buildTokenDictionary({});
    expect(d).toEqual({ kinds: [], byKind: new Map<string, Token[]>(), size: 0 });
  });
});

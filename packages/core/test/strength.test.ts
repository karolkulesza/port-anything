import { describe, expect, it } from 'vitest';
import { applyMutant, isMutableSource, parseElementsReport, sampleMutants, scoreMutants, sourceMutants } from '../src/strength.js';

describe('scoreMutants', () => {
  it('scores the caught share of the mutants that built, timeouts counting as survivors', () => {
    const score = scoreMutants([
      { name: 'b', status: 'caught' },
      { name: 'a', status: 'caught' },
      { name: 'c', status: 'missed' },
      { name: 'd', status: 'timeout' },
      { name: 'e', status: 'unviable' },
      { name: 'f', status: 'caught' },
    ]);
    expect(score).toEqual({ mutants: 6, caught: 3, missed: 1, timeout: 1, unviable: 1, score: 0.6, survivors: ['c', 'd'], caught_mutants: ['a', 'b', 'f'] });
  });

  it('rounds to 4 decimals, and has no score when no mutant built', () => {
    expect(scoreMutants([...Array.from({ length: 54 }, (_, i) => ({ name: `c${i}`, status: 'caught' as const })), ...Array.from({ length: 5 }, (_, i) => ({ name: `m${i}`, status: 'missed' as const }))]).score).toBe(0.9153);
    expect(scoreMutants([{ name: 'x', status: 'unviable' }]).score).toBeNull();
    expect(scoreMutants([]).score).toBeNull();
  });
});

describe('sampleMutants', () => {
  const names = Array.from({ length: 50 }, (_, i) => `src/a.rs:${i + 1}:1: replace + with -`);

  it('keeps every mutant when there are no more than asked for', () => {
    expect(sampleMutants(names, 50)).toEqual(names);
    expect(sampleMutants(names, 200)).toEqual(names);
  });

  it('picks the same mutants every time, in their original order', () => {
    const sample = sampleMutants(names, 10);
    expect(sample).toHaveLength(10);
    expect(sampleMutants(names, 10)).toEqual(sample);
    expect(sampleMutants([...names].reverse(), 10)).toEqual([...sample].reverse());
    expect(sample).toEqual(names.filter((n) => sample.includes(n)));
  });

  it('keeps the earlier pick when more code adds mutants that rank after it', () => {
    const sample = sampleMutants(names, 10);
    const more = [...names, ...Array.from({ length: 50 }, (_, i) => `src/b.rs:${i + 1}:1: replace + with -`)];
    const bigger = sampleMutants(more, 20);
    // Every name is ranked by its own hash, so a larger sample of a larger set holds most of the first.
    expect(sample.filter((n) => bigger.includes(n)).length).toBeGreaterThanOrEqual(5);
  });
});

describe('parseElementsReport', () => {
  const mutant = (status: string, line: number, extra = {}) => ({ id: String(line), mutatorName: 'EqualityOperator', replacement: 'a !== b', status, location: { start: { line, column: 3 }, end: { line, column: 10 } }, ...extra });

  it('maps statuses and names each mutant by place and change', () => {
    const results = parseElementsReport({
      schemaVersion: '2',
      files: {
        'src/wc.js': {
          language: 'javascript',
          mutants: [
            mutant('Killed', 1),
            mutant('Survived', 2),
            mutant('NoCoverage', 3),
            mutant('Timeout', 4),
            mutant('CompileError', 5),
            mutant('RuntimeError', 6),
            mutant('Ignored', 7),
            mutant('Killed', 8, { mutatorName: 'BlockStatement', replacement: '{\n  }' }),
            mutant('Killed', 9, { mutatorName: 'cxx_add_to_sub', replacement: undefined }),
          ],
        },
      },
    });
    expect(results).toEqual([
      { name: 'src/wc.js:1:3: EqualityOperator, replace with a !== b', status: 'caught' },
      { name: 'src/wc.js:2:3: EqualityOperator, replace with a !== b', status: 'missed' },
      { name: 'src/wc.js:3:3: EqualityOperator, replace with a !== b', status: 'missed' },
      { name: 'src/wc.js:4:3: EqualityOperator, replace with a !== b', status: 'timeout' },
      { name: 'src/wc.js:5:3: EqualityOperator, replace with a !== b', status: 'unviable' },
      { name: 'src/wc.js:6:3: EqualityOperator, replace with a !== b', status: 'unviable' },
      { name: 'src/wc.js:8:3: BlockStatement, replace with { }', status: 'caught' },
      { name: 'src/wc.js:9:3: cxx_add_to_sub', status: 'caught' },
    ]);
  });

  it('refuses a report it does not understand', () => {
    expect(() => parseElementsReport({})).toThrow('no "files"');
    expect(() => parseElementsReport({ files: { a: {} } })).toThrow('no mutants array for a');
    expect(() => parseElementsReport({ files: { a: { mutants: [mutant('Exploded', 1)] } } })).toThrow('Unknown mutant status "Exploded"');
  });
});

describe('sourceMutants', () => {
  const changes = (file: string, text: string) => sourceMutants(file, text).map((m) => m.name.replace(`${file}:`, ''));

  it('swaps operators, deletes negation, flips booleans and bumps integers in C-like code', () => {
    expect(changes('wc.c', 'if (a == b && !c) n += 1;\nreturn x - 2 < y ? true : 0;\n')).toEqual([
      '1:7: replace == with !=',
      '1:12: replace && with ||',
      '1:15: delete !',
      '1:21: replace += with -=',
      '1:24: replace 1 with 2',
      '2:10: replace - with +',
      '2:12: replace 2 with 3',
      '2:14: replace < with <=',
      '2:20: replace true with false',
      '2:27: replace 0 with 1',
    ]);
  });

  it('leaves strings, comments, preprocessor lines and other operators alone', () => {
    const text = [
      '#include <stdio.h>',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
      '// a == b',
      '/* x < 1',
      '   y > 2 */',
      'printf("%d <= %d\\n", a, -1);',
      "char c = '<';",
      'p->next++; i << 2; x = -y;',
    ].join('\n');
    expect(changes('wc.c', text)).toEqual(['6:26: replace 1 with 2', '8:17: replace 2 with 3']);
  });

  it('reads # as a comment and flips and/or in Python', () => {
    expect(changes('wc.py', 'if a and not b:  # a == b\n    return """x < y""" or True\n')).toEqual([
      '1:6: replace and with or',
      '2:24: replace or with and',
      '2:27: replace True with False',
    ]);
  });

  it('tells a Rust lifetime from a character literal', () => {
    expect(changes('main.rs', "fn f<'a>(s: &'a str) -> bool { s == \"x\" && c != 'y' }")).toEqual([
      // Generic angle brackets look like comparisons; such mutants don't compile and count as unviable.
      '1:5: replace < with <=',
      '1:8: replace > with >=',
      '1:34: replace == with !=',
      '1:41: replace && with ||',
      '1:46: replace != with ==',
    ]);
  });

  it('skips Lua comments and numbers that are not plain decimals', () => {
    expect(changes('wc.lua', '-- x == 1\nlocal n = 0x10 + 1.5 --[[ a < b ]] if a ~= b then end')).toEqual(['2:16: replace + with -']);
  });

  it('only mutates known source files', () => {
    expect(isMutableSource('src/main.go')).toBe(true);
    expect(isMutableSource('build.sh')).toBe(false);
    expect(sourceMutants('README.md', 'a == b')).toEqual([]);
  });

  it('applies a mutant at its offset, and refuses one whose source moved', () => {
    const text = 'a < b';
    const [m] = sourceMutants('x.js', text);
    expect(applyMutant(text, m!)).toBe('a <= b');
    expect(() => applyMutant('ab < c', m!)).toThrow('no longer has "<" there');
  });
});

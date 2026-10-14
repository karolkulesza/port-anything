import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';
import { buildTokenDictionary, tokenize } from '../src/token-dictionary.js';
import { TOKEN_MUTATION_OPS, generateTokenMutants, mutateTokens } from '../src/token-mutation.js';

const SEEDS = ['.items[] | select(.n > 1)', 'map(.name) | join(", ")', '{a: .b, c: [1, 2]}', 'if . then "x" else empty end', 'length'];
const dictionary = buildTokenDictionary({ seeds: SEEDS });

function balanced(text: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const t of tokenize(text)) {
    if (t.kind !== 'delimiter') continue;
    if ('([{'.includes(t.text)) stack.push(t.text);
    else if (t.text in pairs && stack.pop() !== pairs[t.text]) return false;
  }
  return stack.length === 0;
}

describe('generateTokenMutants', () => {
  const options = { dictionary, count: 50, seed: 7, generator: 'v1' } as const;

  it('is deterministic for the same seeds, dictionary, seed and generator version', () => {
    expect(generateTokenMutants(SEEDS, options)).toEqual(generateTokenMutants(SEEDS, options));
  });

  it('changes with the seed', () => {
    expect(generateTokenMutants(SEEDS, { ...options, seed: 8 })).not.toEqual(generateTokenMutants(SEEDS, options));
  });

  it('pins the v1 output, so a refactor cannot silently change committed corpora', () => {
    expect(generateTokenMutants(SEEDS, { ...options, count: 6 })).toMatchInlineSnapshot(`
      [
        {
          "op": "insert",
          "parent": 1,
          "text": "map(.name) name| join(", ")",
        },
        {
          "op": "insert",
          "parent": 0,
          "text": ".items[2] | select(.n > 1)",
        },
        {
          "op": "insert",
          "parent": 1,
          "text": "map map(.name) | join(", ")",
        },
        {
          "op": "splice",
          "parent": 3,
          "text": "length",
        },
        {
          "op": "replace",
          "parent": 4,
          "text": "c",
        },
        {
          "op": "replace",
          "parent": 1,
          "text": "map(.name) | select(", ")",
        },
      ]
    `);
  });

  it('uses every op, names a real parent and changes the parent', () => {
    const mutants = generateTokenMutants(SEEDS, { ...options, count: 300 });
    expect(new Set(mutants.map((m) => m.op))).toEqual(new Set(TOKEN_MUTATION_OPS));
    for (const m of mutants) {
      expect(SEEDS[m.parent]).toBeDefined();
      expect(m.text).not.toBe(SEEDS[m.parent]);
    }
  });

  it('refuses an empty seed list', () => {
    expect(() => generateTokenMutants([], options)).toThrow(RangeError);
  });
});

describe('mutateTokens', () => {
  it('replace keeps brackets and splice moves balanced runs, so balanced seeds stay balanced', () => {
    const rng = createRng('balance', 'v1');
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const m = mutateTokens(SEEDS[i % SEEDS.length]!, rng, dictionary, SEEDS);
      if (m.op === 'insert') continue;
      expect(balanced(m.text), `${m.op}: ${m.text}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('replace swaps a token for one of the same kind', () => {
    const rng = createRng('replace', 'v1');
    const seed = 'map(.name) | join(", ")';
    const before = tokenize(seed).map((t) => t.kind);
    let seen = 0;
    for (let i = 0; i < 200; i++) {
      const m = mutateTokens(seed, rng, dictionary);
      if (m.op !== 'replace') continue;
      expect(tokenize(m.text).filter((t) => t.kind !== 'space').map((t) => t.kind)).toEqual(before.filter((k) => k !== 'space'));
      seen++;
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('adds a space where a new token would merge with its neighbour', () => {
    const words = buildTokenDictionary({ seeds: ['alpha beta', 'gamma'] });
    const rng = createRng('space', 'v1');
    for (let i = 0; i < 200; i++) {
      const m = mutateTokens('alpha beta', rng, words, ['gamma', 'alpha beta']);
      for (const t of tokenize(m.text)) if (t.kind === 'word') expect(['alpha', 'beta', 'gamma']).toContain(t.text);
    }
    const ops = buildTokenDictionary({ seeds: ['a = b', 'a == b'] });
    for (let i = 0; i < 200; i++) {
      for (const t of tokenize(mutateTokens('a = b', rng, ops).text)) if (t.kind === 'operator') expect(['=', '==']).toContain(t.text);
    }
  });

  it('replace changes exactly one token and keeps the rest of the text as it was', () => {
    const rng = createRng('untouched', 'v1');
    const seed = 'a-b  |  c';
    const d = buildTokenDictionary({ seeds: [seed, 'x // y'] });
    let seen = 0;
    for (let i = 0; i < 200; i++) {
      const m = mutateTokens(seed, rng, d);
      if (m.op !== 'replace') continue;
      let p = 0;
      while (p < seed.length && seed[p] === m.text[p]) p++;
      let q = 0;
      while (q < seed.length - p && seed.at(-1 - q) === m.text.at(-1 - q)) q++;
      const removed = tokenize(seed.slice(p, seed.length - q)).filter((t) => t.kind !== 'space');
      expect(removed.length, m.text).toBeLessThanOrEqual(1);
      seen++;
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('inserts into empty text, and leaves text alone when there is nothing to work with', () => {
    expect(mutateTokens('', createRng(1, 'v1'), dictionary).op).toBe('insert');
    expect(mutateTokens('', createRng(1, 'v1'), dictionary).text).not.toBe('');
    expect(mutateTokens('', createRng(1, 'v1'), buildTokenDictionary({}))).toEqual({ text: '', op: 'insert' });
  });
});

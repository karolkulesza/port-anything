import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATOR, GENERATOR_VERSIONS, baseGenerator, createRng, type GeneratorVersion } from '../src/rng.js';

const draw = (seed: string | number, generator: GeneratorVersion = 'v1', n = 8) => {
  const rng = createRng(seed, generator);
  return Array.from({ length: n }, () => rng.uint32());
};

describe('createRng', () => {
  it('gives the same sequence for the same seed and generator version', () => {
    expect(draw('abc')).toEqual(draw('abc'));
    expect(draw(42)).toEqual(draw('42'));
  });

  it('gives different sequences for different seeds', () => {
    expect(draw('abc')).not.toEqual(draw('abd'));
    expect(draw(0)).not.toEqual(draw(1));
  });

  it('pins the v1 stream, so a refactor cannot silently change committed corpora', () => {
    expect(draw(1, 'v1', 4)).toMatchInlineSnapshot(`
      [
        2173581305,
        1448430132,
        2896301467,
        2139681223,
      ]
    `);
  });

  it('refuses a generator version this release does not ship', () => {
    expect(() => createRng(1, 'v0' as GeneratorVersion)).toThrow(/Unknown generator version "v0"/);
    expect(GENERATOR_VERSIONS).toContain(DEFAULT_GENERATOR);
  });

  it('refuses a seed that is not a safe integer', () => {
    expect(() => createRng(1.5, 'v1')).toThrow(RangeError);
    expect(() => createRng(Number.NaN, 'v1')).toThrow(RangeError);
  });

  it('int(n) stays in range and covers every value', () => {
    const rng = createRng('int', 'v1');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const x = rng.int(7);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
      seen.add(x);
    }
    expect(seen.size).toBe(7);
    expect(rng.int(1)).toBe(0);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(2.5)).toThrow(RangeError);
  });

  it('pick() returns an element and refuses an empty array', () => {
    const rng = createRng('pick', 'v1');
    expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});

describe('baseGenerator', () => {
  it('draws v2 argv cases and byte mutants from the v1 streams, so v2 only adds the committed-case stage', () => {
    expect(baseGenerator('v1')).toBe('v1');
    expect(baseGenerator('v2')).toBe('v1');
  });
});

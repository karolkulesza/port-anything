import { createHash } from 'node:crypto';

/**
 * Generator versions this release can run. A corpus pins one (`corpus.generator`), and every
 * release keeps shipping the old ones, so upgrading never silently changes a committed corpus.
 */
export const GENERATOR_VERSIONS = ['v1', 'v2'] as const;
export type GeneratorVersion = (typeof GENERATOR_VERSIONS)[number];

/** Generator version a new corpus starts on. */
export const DEFAULT_GENERATOR: GeneratorVersion = 'v2';

/**
 * The version whose random streams the argv cases and byte mutants draw from. v2 is v1 plus the
 * mutation of committed cases, so without committed cases a v2 corpus is the v1 corpus.
 */
export function baseGenerator(generator: GeneratorVersion): GeneratorVersion {
  return generator === 'v2' ? 'v1' : generator;
}

/** Deterministic random source: the same seed and generator version always give the same sequence. */
export interface Rng {
  /** Next 32-bit unsigned integer. */
  uint32(): number;
  /** Uniform integer in `[0, n)`; `n` must be a positive safe integer up to 2^32. */
  int(n: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

export function isGeneratorVersion(value: string): value is GeneratorVersion {
  return (GENERATOR_VERSIONS as readonly string[]).includes(value);
}

/**
 * xoshiro128** seeded from SHA-256 of the generator version and the seed. Mixing in the version
 * means a new generator draws a different stream even for the same seed, so it can't pass for the
 * old one. A number seed and its decimal string are the same seed.
 */
export function createRng(seed: string | number, generator: GeneratorVersion): Rng {
  if (!isGeneratorVersion(generator)) {
    throw new Error(`Unknown generator version ${JSON.stringify(generator)}; this release supports ${GENERATOR_VERSIONS.join(', ')}.`);
  }
  if (typeof seed === 'number' && !Number.isSafeInteger(seed)) throw new RangeError(`Seed must be a safe integer, got ${seed}.`);
  const digest = createHash('sha256').update(`port-anything generator ${generator}\0${seed}`).digest();
  let a = digest.readUInt32LE(0), b = digest.readUInt32LE(4), c = digest.readUInt32LE(8), d = digest.readUInt32LE(12);
  if ((a | b | c | d) === 0) a = 1; // the all-zero state never moves

  const uint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };

  const int = (n: number): number => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`int(n) needs 1 <= n <= 2^32, got ${n}.`);
    // Rejection sampling: drop the top values that would make some results more likely than others.
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) {
      const x = uint32();
      if (x < limit) return x % n;
    }
  };

  return {
    uint32,
    int,
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick() needs a non-empty array.');
      return items[int(items.length)]!;
    },
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

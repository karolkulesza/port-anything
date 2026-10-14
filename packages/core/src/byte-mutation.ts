import { createRng, type GeneratorVersion, type Rng } from './rng.js';

export const BYTE_MUTATION_OPS = ['flip', 'set', 'insert', 'delete', 'truncate', 'splice'] as const;
export type ByteMutationOp = (typeof BYTE_MUTATION_OPS)[number];

export interface ByteMutant {
  bytes: Uint8Array;
  op: ByteMutationOp;
  /** Index of the seed it was derived from. */
  parent: number;
}

/**
 * Applies one byte-level mutation: flip a bit, set a byte to a different random value, insert a random byte,
 * delete a byte, truncate, or splice the tail of a donor onto a prefix. Empty input can only grow.
 */
export function mutateBytes(data: Uint8Array, rng: Rng, donors: readonly Uint8Array[] = []): { bytes: Uint8Array; op: ByteMutationOp } {
  if (data.length === 0) return { bytes: Uint8Array.of(rng.int(256)), op: 'insert' };
  const op = rng.pick(donors.length > 0 ? BYTE_MUTATION_OPS : BYTE_MUTATION_OPS.filter((o) => o !== 'splice'));
  const at = rng.int(data.length);
  const out = Uint8Array.from(data);
  switch (op) {
    case 'flip':
      out[at] = out[at]! ^ (1 << rng.int(8));
      return { bytes: out, op };
    case 'set':
      out[at] = (out[at]! + 1 + rng.int(255)) % 256; // always a different byte
      return { bytes: out, op };
    case 'insert':
      return { bytes: concat(data.subarray(0, at), Uint8Array.of(rng.int(256)), data.subarray(at)), op };
    case 'delete':
      return { bytes: concat(data.subarray(0, at), data.subarray(at + 1)), op };
    case 'truncate':
      return { bytes: data.slice(0, at), op };
    case 'splice': {
      const donor = rng.pick(donors);
      return { bytes: concat(data.subarray(0, at), donor.subarray(rng.int(donor.length + 1))), op };
    }
  }
}

/** Derives `count` byte mutants from `seeds`, deterministic for the seeds, `seed` and the generator version. */
export function generateByteMutants(
  seeds: readonly Uint8Array[],
  options: { count: number; seed: string | number; generator: GeneratorVersion },
): ByteMutant[] {
  if (seeds.length === 0) throw new RangeError('Byte mutation needs at least one seed.');
  const rng = createRng(options.seed, options.generator);
  return Array.from({ length: options.count }, () => {
    const parent = rng.int(seeds.length);
    return { ...mutateBytes(seeds[parent]!, rng, seeds), parent };
  });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

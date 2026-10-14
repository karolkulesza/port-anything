import { describe, expect, it } from 'vitest';
import { BYTE_MUTATION_OPS, generateByteMutants, mutateBytes } from '../src/byte-mutation.js';
import { createRng } from '../src/rng.js';

const SEEDS = ['.items[] | .id', 'map(.name)', '{"a": 1}'].map((s) => new Uint8Array(Buffer.from(s)));
const options = { count: 40, seed: 3, generator: 'v1' } as const;

describe('generateByteMutants', () => {
  it('is deterministic for the same seeds, seed and generator version', () => {
    expect(generateByteMutants(SEEDS, options)).toEqual(generateByteMutants(SEEDS, options));
    expect(generateByteMutants(SEEDS, { ...options, seed: 4 })).not.toEqual(generateByteMutants(SEEDS, options));
  });

  it('pins the v1 output', () => {
    const out = generateByteMutants(SEEDS, { ...options, count: 6 }).map((m) => ({ op: m.op, parent: m.parent, hex: Buffer.from(m.bytes).toString('hex') }));
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "hex": "7b22616974656d735b5d207c202e6964",
          "op": "splice",
          "parent": 2,
        },
        {
          "hex": "2e6974656d715b5d207c202e6964",
          "op": "flip",
          "parent": 0,
        },
        {
          "hex": "7b2261223ab0317d",
          "op": "set",
          "parent": 2,
        },
        {
          "hex": "7b61223a20317d",
          "op": "delete",
          "parent": 2,
        },
        {
          "hex": "7b2261403a20317d",
          "op": "set",
          "parent": 2,
        },
        {
          "hex": "2e6974656d735b5d207c205f2e6964",
          "op": "insert",
          "parent": 0,
        },
      ]
    `);
  });

  it('uses every op and never changes its input', () => {
    const copies = SEEDS.map((s) => Uint8Array.from(s));
    const mutants = generateByteMutants(SEEDS, { ...options, count: 300 });
    expect(new Set(mutants.map((m) => m.op))).toEqual(new Set(BYTE_MUTATION_OPS));
    expect(SEEDS).toEqual(copies);
  });

  it('changes the length the way each op says', () => {
    const rng = createRng('len', 'v1');
    const data = SEEDS[0]!;
    for (let i = 0; i < 200; i++) {
      const { bytes, op } = mutateBytes(data, rng);
      if (op === 'flip' || op === 'set') {
        expect(bytes.length).toBe(data.length);
        expect(bytes).not.toEqual(data);
      }
      if (op === 'insert') expect(bytes.length).toBe(data.length + 1);
      if (op === 'delete') expect(bytes.length).toBe(data.length - 1);
      if (op === 'truncate') expect(bytes.length).toBeLessThan(data.length);
      expect(op).not.toBe('splice'); // no donors given
    }
  });

  it('grows empty input and refuses an empty seed list', () => {
    expect(mutateBytes(new Uint8Array(), createRng(1, 'v1')).bytes.length).toBe(1);
    expect(() => generateByteMutants([], options)).toThrow(RangeError);
  });
});

import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@port-anything/core', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@port-anything/core');
  });
});

describe('generator exports', () => {
  it('exposes token and byte mutation from the package entry', async () => {
    const core = await import('../src/index.js');
    const dictionary = core.buildTokenDictionary({ seeds: ['.a | .b'] });
    expect(core.generateTokenMutants(['.a | .b'], { dictionary, count: 2, seed: 1, generator: core.DEFAULT_GENERATOR })).toHaveLength(2);
    expect(core.generateByteMutants([new Uint8Array([1, 2])], { count: 2, seed: 1, generator: 'v1' })).toHaveLength(2);
  });
});

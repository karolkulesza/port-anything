import type { Options } from 'tsup';

/** Shared tsup settings: ESM only, Node 22, with type declarations. */
export const base = {
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
} satisfies Options;

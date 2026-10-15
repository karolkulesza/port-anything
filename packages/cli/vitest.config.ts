import { defineConfig } from 'vitest/config';

// The compare demos (real sort binaries, hundreds of sandboxed cases, a time limit on Linux) run
// after the other tests, on their own, so they don't compete with them for the CPU.
const DEMOS = ['test/compare.linux.test.ts', 'test/compare.darwin.test.ts'];

export default defineConfig({
  test: {
    // Most CLI tests spawn real programs, often sandboxed, several times per case; under load (a
    // busy CI runner, parallel test files) one takes well over vitest's 5 s default.
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: 'unit', exclude: ['**/node_modules/**', ...DEMOS], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'demo', include: DEMOS, sequence: { groupOrder: 1 } } },
    ],
  },
});

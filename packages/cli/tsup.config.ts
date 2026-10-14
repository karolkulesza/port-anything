import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import { base } from '../../tsup.base.js';

// The engine is bundled into the published CLI from its sources (the @port-anything/* packages
// aren't on npm yet), so `npx port-anything` installs one package and a clean checkout builds
// the CLI without building core first. Core's own dependencies stay external and are declared here.
export default defineConfig({
  ...base,
  entry: ['src/index.ts', 'src/bin.ts'],
  noExternal: ['@port-anything/core'],
  esbuildOptions(options) {
    options.alias = { '@port-anything/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) };
  },
});

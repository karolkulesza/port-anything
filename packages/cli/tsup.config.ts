import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import { base } from '../../tsup.base.js';

// The engine, the report renderer and the MCP server are bundled into the published CLI from their sources (the
// @port-anything/* packages aren't on npm yet), so `npx port-anything` installs one package and a
// clean checkout builds the CLI without building them first. Their own dependencies stay external
// and are declared here.
export default defineConfig({
  ...base,
  // `hook` runs the build and the smoke run in a worker it can stop at its time cap.
  entry: ['src/index.ts', 'src/bin.ts', 'src/hook-worker.ts'],
  noExternal: ['@port-anything/core', '@port-anything/report', '@port-anything/mcp'],
  esbuildOptions(options) {
    options.alias = {
      '@port-anything/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@port-anything/report': fileURLToPath(new URL('../report/src/index.ts', import.meta.url)),
      '@port-anything/mcp': fileURLToPath(new URL('../mcp/src/index.ts', import.meta.url)),
    };
  },
  // `port-anything setup` installs the agent skills from the package, so they ship in it.
  async onSuccess() {
    await cp(new URL('../../skills', import.meta.url), new URL('./dist/skills', import.meta.url), { recursive: true });
  },
});

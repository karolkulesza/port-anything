#!/usr/bin/env node
// Sets the version of each agent manifest at the repo root to the CLI package's version. Run by
// `pnpm version-packages` right after `changeset version` bumps the package.
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json', 'gemini-extension.json'];
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('packages/cli/package.json', root), 'utf8'));
for (const path of MANIFESTS) {
  const url = new URL(path, root);
  const manifest = JSON.parse(readFileSync(url, 'utf8'));
  if (manifest.version === version) continue;
  manifest.version = version;
  writeFileSync(url, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path}: ${version}`);
}

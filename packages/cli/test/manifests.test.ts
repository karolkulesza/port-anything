import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER } from '../src/setup-command.js';

// The plugin and extension manifests at the repo root let each agent install the skills and the
// MCP server straight from the repo. They must agree with the package and with what `setup` registers.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
const pkg = read('packages/cli/package.json') as { version: string; description: string; license: string };
const skillNames = readdirSync(join(root, 'skills')).filter((name) => existsSync(join(root, 'skills', name, 'SKILL.md')));
const server = { command: MCP_SERVER.command, args: [...MCP_SERVER.args] };

const PLUGINS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json'];

describe('agent manifests', () => {
  // `pnpm version-packages` keeps the versions in step (scripts/sync-manifest-versions.mjs).
  it.each([...PLUGINS, 'gemini-extension.json'])('%s names the package at its version', (path) => {
    const manifest = read(path);
    expect(manifest.name).toBe('port-anything');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description).toBe(pkg.description);
  });

  it.each(PLUGINS)('%s points at the skills and at the MCP server setup registers', (path) => {
    const manifest = read(path) as { license: string; skills?: string; mcpServers: string };
    expect(manifest.license).toBe(pkg.license);
    // Claude Code finds skills/ at the plugin root by itself; the others are told.
    if (manifest.skills !== undefined) expect(manifest.skills).toBe('./skills/');
    expect(read(manifest.mcpServers)).toEqual({ mcpServers: { [MCP_SERVER.name]: server } });
  });

  it('gemini-extension.json declares the same MCP server; skills/ sits at the extension root', () => {
    expect(read('gemini-extension.json').mcpServers).toEqual({ [MCP_SERVER.name]: server });
    expect(skillNames.length).toBeGreaterThan(0);
  });

  it('the Claude Code marketplace lists the plugin at the repo root', () => {
    const marketplace = read('.claude-plugin/marketplace.json') as { name: string; owner: { name: string }; plugins: { name: string; source: string }[] };
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'port-anything', source: './' })]);
  });

  it('skills.sh.json groups every skill once, in the shape skills.sh accepts', () => {
    const manifest = read('skills.sh.json') as { groupings: { title: string; description?: string; skills: string[] }[] };
    expect(Object.keys(manifest).sort()).toEqual(['$schema', 'groupings', 'notGrouped']);
    expect(manifest.groupings.length).toBeGreaterThanOrEqual(1);
    for (const g of manifest.groupings) expect(Object.keys(g).every((k) => ['title', 'description', 'skills'].includes(k))).toBe(true);
    expect(manifest.groupings.flatMap((g) => g.skills).sort()).toEqual([...skillNames].sort());
  });
});

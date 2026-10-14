import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// The published `port-anything` package must work on its own after `npm install`: the engine is
// bundled into it (the @port-anything/* packages aren't on npm yet), every other import is a
// declared dependency, and the tarball carries the built CLI, a README and the license.

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const distFiles = () => readdirSync(new URL('../dist', import.meta.url)).filter((f) => f.endsWith('.js'));
const distSource = (f: string) => readFileSync(new URL(`../dist/${f}`, import.meta.url), 'utf8');

/** Bare module specifiers imported by a built ESM file (static and dynamic imports). */
function bareImports(source: string): string[] {
  const specs = [...source.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm), ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  return specs.filter((s) => !s.startsWith('.') && !s.startsWith('/'));
}

const packageName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

describe('published package (run `pnpm build` first)', () => {
  it('declares no workspace-only dependency a registry install could not resolve', () => {
    for (const deps of [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
      for (const [name, range] of Object.entries(deps ?? {})) {
        expect(range, name).not.toMatch(/^workspace:/);
        expect(name, name).not.toMatch(/^@port-anything\//);
      }
    }
  });

  it('bundles the engine and imports only node builtins and declared dependencies', () => {
    const files = distFiles();
    expect(files).toContain('bin.js');
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const builtins = new Set(builtinModules);
    const imported = new Set(files.flatMap((f) => bareImports(distSource(f))));
    expect(imported.size).toBeGreaterThan(0);
    for (const spec of imported) {
      if (spec.startsWith('node:') || builtins.has(spec)) continue;
      expect(declared, `dist imports ${spec}`).toContain(packageName(spec));
    }
  });

  it('packs the built CLI, a README with the compare quickstart and the license, and no sources', async () => {
    const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkgDir });
    const [result] = JSON.parse(stdout) as [{ version: string; files: { path: string }[] }];
    const paths = result.files.map((f) => f.path);
    expect(result.version).toBe(pkg.version);
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'README.md', 'LICENSE', pkg.bin['port-anything']!, 'dist/index.js', 'dist/index.d.ts']));
    expect(paths.filter((p) => p.startsWith('src/') || p.startsWith('test/'))).toEqual([]);
    expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).toContain('npx port-anything compare');
    expect(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../../../LICENSE', import.meta.url), 'utf8'));
  });

  it('carries a released version (changesets bumps it from the 0.0.0 placeholder)', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).not.toBe('0.0.0');
  });
});

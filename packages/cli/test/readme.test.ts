import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');

/** The `##` headings of the README, in order. */
const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);

/** The body of the `##` section whose heading starts with `title`. */
function section(title: string): string {
  const start = readme.search(new RegExp(`^## ${title}`, 'm'));
  expect(start, `section ${title}`).toBeGreaterThanOrEqual(0);
  const next = readme.slice(start + 3).search(/^## /m);
  return next < 0 ? readme.slice(start) : readme.slice(start, start + 3 + next);
}

describe('README', () => {
  it('says the scope on its first line', () => {
    expect(readme.split('\n')[0]).toBe('v0.1 covers non-interactive CLIs.');
  });

  it('states the v0.1 scope before the quickstart: pipes only, and what is out of scope', () => {
    const intro = readme.slice(0, readme.indexOf('## Quickstart'));
    expect(intro).toContain('**Scope of v0.1:**');
    for (const words of ['with pipes', 'never a terminal', 'TUIs, interactive prompts', 'network services', 'GUI apps']) expect(intro, words).toContain(words);
  });

  it('has the quickstart, prior art, integrity and showcases sections, quickstart first', () => {
    expect(headings[0]).toMatch(/^Quickstart/);
    for (const title of ['Prior art', 'Integrity', 'Showcases']) expect(headings.some((h) => h.startsWith(title)), title).toBe(true);
  });

  it('shows the compare GIF above the quickstart', () => {
    const slot = readme.indexOf('](docs/demo/compare.gif)');
    expect(slot).toBeGreaterThan(0);
    expect(slot).toBeLessThan(readme.indexOf('## Quickstart'));
  });

  it("doesn't show sort's -k, -n or -r as untested in the sample output", () => {
    const untested = /^untested \(no generated case\): (.*)$/m.exec(section('Quickstart'))?.[1]?.split(', ') ?? [];
    for (const feature of ['opt.key', 'opt.k', 'opt.numeric-sort', 'opt.n', 'opt.reverse', 'opt.r']) expect(untested).not.toContain(feature);
  });

  it('gives a Linux and a macOS one-liner with explicit binaries', () => {
    const quickstart = section('Quickstart');
    expect(quickstart).toContain("npx port-anything compare /usr/bin/sort 'coreutils sort'");
    expect(quickstart).toContain('npx port-anything compare /usr/bin/sort gsort');
  });

  it('names the prior art', () => {
    const prior = section('Prior art');
    for (const name of ['uufuzz', 'flagdiff', 'coreutils-tracking', 'Babelmark', 'cargo-mutants', 'trycmd', 'insta', 'bats', 'cram', 'shelltestrunner', 'diffoscope', 'keploy', 'giflib-rs', 'A-Raphie/parity']) {
      expect(prior, name).toContain(name);
    }
  });

  it('states the integrity threat model plainly', () => {
    const integrity = section('Integrity');
    expect(integrity).toContain('runs locally as you, with a shell');
    expect(integrity).toMatch(/slower and visible, not impossible/);
    expect(integrity).toContain('fresh holdout');
  });

  it('links only to files that exist in the repo', () => {
    const local = [...readme.matchAll(/\]\(([^)#:]+)\)/g)].map((m) => m[1]!);
    expect(local.length).toBeGreaterThan(0);
    for (const path of local) expect(existsSync(fileURLToPath(new URL(path, root))), path).toBe(true);
  });
});

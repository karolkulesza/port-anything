import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

/** The repo README (GitHub) and the package README (npm). */
const readmes = {
  'README.md': readFileSync(new URL('../../../README.md', import.meta.url), 'utf8'),
  'packages/cli/README.md': readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
};

/** Each subcommand a README runs in its shell blocks, with every option it tells people to pass to it. */
function commandOptions(readme: string): Map<string, Set<string>> {
  const invocations = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1]!.split('\n'))
    .flatMap((line) => [...line.replace(/#.*/, '').matchAll(/(?:^|\s)(?:npx )?port-anything ([a-z][a-z-]*)([^;&|]*)/g)])
    .map((m) => ({ sub: m[1]!, options: [...m[2]!.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((o) => o[1]!) }));
  const options = new Map<string, Set<string>>();
  for (const { sub, options: opts } of invocations) {
    const set = options.get(sub) ?? new Set<string>();
    for (const o of opts) set.add(o);
    options.set(sub, set);
  }
  // The quickstart's options table lists compare's options.
  for (const m of readme.matchAll(/^\| `(--[a-z][a-z-]*)[^`]*` \|/gm)) options.get('compare')?.add(m[1]!);
  return options;
}

/** The usage line a subcommand prints for an unknown option, which names every option it takes. */
async function usage(sub: string): Promise<string> {
  const { stderr } = await run([sub, '--no-such-option']);
  return stderr;
}

describe.each(Object.entries(readmes))('%s commands', (_name, readme) => {
  const options = commandOptions(readme);

  it('uses at least compare, run, report and waive, and documents compare options', () => {
    for (const sub of ['compare', 'run', 'report', 'waive']) expect([...options.keys()]).toContain(sub);
    expect([...options.get('compare')!]).toEqual(expect.arrayContaining(['--budget', '--json', '--save', '--i-know', '--no-sandbox']));
  });

  it.each([...options])('port-anything %s exists in this version and takes the options the README passes', async (sub, opts) => {
    const text = await usage(sub);
    expect(text).not.toContain('is not available yet');
    const line = text.split('\n').find((l) => l.startsWith(`Usage: port-anything ${sub}`));
    expect(line, `usage line of ${sub}`).toBeDefined();
    for (const o of opts) expect(line, `${sub} ${o}`).toMatch(new RegExp(`${o}(?![a-z-])`));
  });
});

describe('packages/cli/README.md', () => {
  const npm = readmes['packages/cli/README.md'];

  it('gives the same quickstart one-liners as the repo README', () => {
    const oneLiners = (readme: string) => readme.match(/^npx port-anything compare .*$/gm) ?? [];
    expect(oneLiners(npm).length).toBeGreaterThan(0);
    expect(oneLiners(npm)).toEqual(expect.arrayContaining(oneLiners(readmes['README.md']).slice(0, 2)));
  });

  it('does not describe what this version ships as still to come', () => {
    expect(npm).not.toMatch(/come in v0\.1|early release: `compare` works/);
  });
});

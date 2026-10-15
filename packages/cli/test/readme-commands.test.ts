import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

/** The `port-anything <sub> …` invocations in the README's shell blocks, with the options each one passes. */
const invocations = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
  .flatMap((m) => m[1]!.split('\n'))
  .flatMap((line) => [...line.replace(/#.*/, '').matchAll(/(?:^|\s)(?:npx )?port-anything ([a-z][a-z-]*)([^;&|]*)/g)])
  .map((m) => ({ sub: m[1]!, options: [...m[2]!.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((o) => o[1]!) }));

/** Each subcommand the README runs, with every option it tells people to pass to it. */
const options = new Map<string, Set<string>>();
for (const { sub, options: opts } of invocations) {
  const set = options.get(sub) ?? new Set<string>();
  for (const o of opts) set.add(o);
  options.set(sub, set);
}
// The quickstart's options table lists compare's options.
for (const m of readme.matchAll(/^\| `(--[a-z][a-z-]*)[^`]*` \|/gm)) options.get('compare')?.add(m[1]!);

/** The usage line a subcommand prints for an unknown option, which names every option it takes. */
async function usage(sub: string): Promise<string> {
  const { stderr } = await run([sub, '--no-such-option']);
  return stderr;
}

describe('README commands', () => {
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

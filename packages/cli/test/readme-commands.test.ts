import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

/** The subcommands the README's shell blocks run, as `port-anything <sub>` or `npx port-anything <sub>`. */
const subcommands = new Set(
  [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1]!.split('\n'))
    .flatMap((line) => [...line.matchAll(/(?:^|\s)(?:npx )?port-anything ([a-z][a-z-]*)/g)].map((m) => m[1]!)),
);

describe('README commands', () => {
  it('uses at least compare, run and report', () => {
    for (const sub of ['compare', 'run', 'report']) expect(subcommands).toContain(sub);
  });

  it.each([...subcommands])('port-anything %s exists in this version', async (sub) => {
    const { stderr } = await run([sub, '--no-such-option']);
    expect(stderr).not.toContain('is not available yet');
  });
});

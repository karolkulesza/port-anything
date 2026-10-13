import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const pkgUrl = new URL('../package.json', import.meta.url);

describe('built bin (run `pnpm build` first)', () => {
  it('is declared in package.json and runs under node', async () => {
    const pkg = JSON.parse(await readFile(pkgUrl, 'utf8')) as { bin: Record<string, string> };
    const bin = pkg.bin['port-anything'];
    expect(bin).toBe('dist/bin.js');
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL(`../${bin}`, import.meta.url))]);
    expect(stdout).toContain('Not released yet.');
  });

  it('starts with a node shebang so npx can run it', async () => {
    const source = await readFile(new URL('../dist/bin.js', import.meta.url), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});

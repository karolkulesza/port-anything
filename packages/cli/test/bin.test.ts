import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const pkgUrl = new URL('../package.json', import.meta.url);
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

describe('built bin (run `pnpm build` first)', () => {
  it('is declared in package.json and runs under node', async () => {
    const pkg = JSON.parse(await readFile(pkgUrl, 'utf8')) as { bin: Record<string, string> };
    const bin = pkg.bin['port-anything'];
    expect(bin).toBe('dist/bin.js');
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL(`../${bin}`, import.meta.url))]);
    expect(stdout).toContain("Usage: port-anything compare '<ref cmd>' '<candidate cmd>'…");
    expect(stdout).not.toContain('Not released yet');
  });

  it('prints the published version with --version (done when)', async () => {
    const pkg = JSON.parse(await readFile(pkgUrl, 'utf8')) as { version: string };
    const { stdout } = await promisify(execFile)(process.execPath, [binPath, '--version']);
    expect(stdout).toBe(`port-anything ${pkg.version}\n`);
  });

  it('starts with a node shebang so npx can run it', async () => {
    const source = await readFile(binPath, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('runs a project: 2 candidates give the same verdicts as two separate runs (done when)', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-bin-')));
    try {
      const tool = (body: string) => `#!/bin/sh\ncase "$1" in\n  echo) shift; echo "$@" ;;\n  upper) ${body} ;;\nesac\n`;
      for (const [file, body] of [['ref', "tr 'a-z' 'A-Z'"], ['good', "tr 'a-z' 'A-Z'"], ['bad', 'cat']]) {
        writeFileSync(join(project, file!), tool(body!));
        chmodSync(join(project, file!), 0o755);
      }
      mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(
        join(project, 'port-anything', 'recorded', 'recorded.jsonl'),
        ['{"argv":["echo","hi"],"origin":"recorded"}', '{"argv":["upper"],"stdin":"hello\\n","origin":"recorded"}', ''].join('\n'),
      );
      const runIn = async (config: string) => {
        writeFileSync(join(project, 'port-anything.yaml'), `version: 1\nprogram_name: tool\nreference: { cmd: ./ref }\n${config}`);
        const child = await promisify(execFile)(process.execPath, [binPath, 'run', '--no-sandbox', '--json'], { cwd: project }).then(
          (r) => ({ ...r, code: 0 }),
          (e: { code: number; stdout: string; stderr: string }) => e,
        );
        return { code: child.code, out: JSON.parse(child.stdout) as { candidates: { command: string; diverge: number }[] } };
      };
      const both = await runIn('candidates:\n  - cmd: ./good\n  - cmd: ./bad\n');
      const good = await runIn('candidate: { cmd: ./good }\n');
      const bad = await runIn('candidate: { cmd: ./bad }\n');
      expect([both.code, good.code, bad.code]).toEqual([1, 0, 1]);
      expect(both.out.candidates).toEqual([...good.out.candidates, ...bad.out.candidates]);
      expect(both.out.candidates.map((c) => c.diverge)).toEqual([0, 1]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});

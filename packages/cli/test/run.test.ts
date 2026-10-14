import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

describe('run', () => {
  it('prints the not-released-yet notice and exits 0 without a command', async () => {
    for (const argv of [[], ['--help']]) {
      const result = await run(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('rewrite it in any language and show nothing changed');
      expect(result.stdout).toContain('Not released yet.');
    }
  });

  it('exits 3 for a command this version does not have', async () => {
    expect(await run(['compare', 'a', 'b'])).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/"compare" is not available yet/) });
  });

  it('dispatches run in the given project directory', async () => {
    const project = mkdtempSync(join(tmpdir(), 'pa-cli-dispatch-'));
    try {
      const missing = await run(['run'], { cwd: project });
      expect(missing.exitCode).toBe(3);
      expect(missing.stderr).toMatch(/^port-anything run: No port-anything\.yaml in /);
      mkdirSync(join(project, 'port-anything'));
      writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./ref }\ncandidate: { cmd: ./port }\n');
      expect((await run(['run', '--no-sandbox'], { cwd: project })).stderr).toMatch(/No cases to run/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

describe('run', () => {
  it('prints the usage and exits 0 without a command', async () => {
    for (const argv of [[], ['--help']]) {
      const result = await run(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('rewrite it in any language and show nothing changed');
      expect(result.stdout).toContain('Usage: port-anything compare');
    }
  });

  it('exits 3 for a command this version does not have', async () => {
    expect(await run(['record', '--cmd', 'x'])).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/"record" is not available yet in this version; only "compare", "run", "baseline" and "spec infer" are/) });
  });

  it('routes spec to the spec command', async () => {
    expect(await run(['spec'])).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/^port-anything spec: which spec command\?/) });
  });

  it('exits 3, not 1, when the run fails unexpectedly', async () => {
    const project = mkdtempSync(join(tmpdir(), 'pa-cli-crash-'));
    try {
      writeFileSync(join(project, 'tool'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
      writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./tool }\ncandidate: { cmd: ./tool }\n');
      mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), '{"argv":["hi"],"origin":"recorded"}\n');
      mkdirSync(join(project, '.port-anything'));
      writeFileSync(join(project, '.port-anything', 'tmp'), ''); // the scratch directory can't be created
      const result = await run(['run', '--no-sandbox'], { cwd: project });
      expect(result).toMatchObject({ exitCode: 3, stdout: '' });
      expect(result.stderr).toMatch(/^port-anything: internal error, the run did not finish:\n.*ENOTDIR/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
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

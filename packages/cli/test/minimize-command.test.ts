import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, cacheDir, canonicalCase, loadRepro, parseConfig, shortCaseId, type CanonicalCase, type SandboxProbe } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeMinimize, minimizeCommand, parseMinimizeArgs, type ExecuteMinimizeOptions } from '../src/minimize-command.js';
import { executeRun } from '../src/run-command.js';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
// A line counter and a port with two bugs: a last line without a newline counts as a line, and a
// usage error exits 1 instead of 2.
const TOOL = (variant: 'ref' | 'bad') => `#!/bin/sh
for a in "$@"; do case "$a" in -x) echo "usage: tool [-l] [FILE]" >&2; exit ${variant === 'ref' ? 2 : 1} ;; esac; done
for a in "$@"; do case "$a" in -*) ;; *) exec < "$a" ;; esac; done
${variant === 'ref' ? "tr -cd '\\n' | wc -c | tr -d ' '" : "awk 'END { print NR }'"}
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('parseMinimizeArgs', () => {
  it('reads the cluster, --json and --no-sandbox', () => {
    expect(parseMinimizeArgs(['20261014-190203-a1b2/2', '--json', '--no-sandbox'])).toEqual({ cluster: '20261014-190203-a1b2/2', json: true, noSandbox: true });
    expect(parseMinimizeArgs(['3'])).toEqual({ cluster: '3', json: false, noSandbox: false });
  });

  it('wants exactly one cluster and no unknown options', () => {
    expect(() => parseMinimizeArgs([])).toThrow(/Which cluster\?/);
    expect(() => parseMinimizeArgs(['1', '2'])).toThrow(/one cluster/);
    expect(() => parseMinimizeArgs(['1', '--runs', '5'])).toThrow(/runs/);
  });
});

describe('executeMinimize', () => {
  let project: string;
  let cases: CanonicalCase[];
  let runId: string;

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-minimize-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-bad'), TOOL('bad'), { mode: 0o755 });
    const store = new BlobStore(cacheDir(project));
    const put = (text: string) => store.put(text);
    cases = [
      { argv: ['-l'], stdin: await put('one\ntwo\nthree'), features: ['opt.l'] },
      { argv: ['-l', 'notes.txt'], fixtures: { 'notes.txt': await put('first\nsecond\r\nlast'), 'other.txt': await put('x\n') }, features: ['opt.l'] },
      // Tagged opt.l only, so that the stdout cluster (2 opt.l cases) ranks first.
      { argv: ['-l', '-x', 'notes.txt'], fixtures: { 'notes.txt': await put('a\n') }, features: ['opt.l'] },
      { argv: ['-l'], stdin: await put('fine\n'), features: ['opt.l'] },
    ].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
    const saved = await executeRun({ ...options(), args: { candidates: [], json: true, noSandbox: true } });
    expect(saved.exitCode).toBe(1);
    runId = (JSON.parse(saved.stdout) as { run_id: string }).run_id;
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const options = (over: Partial<ExecuteMinimizeOptions> = {}): ExecuteMinimizeOptions => ({
    projectDir: project,
    config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-bad' } }),
    cases,
    args: { cluster: '1', json: false, noSandbox: true },
    probe: NO_SANDBOX,
    ...over,
  });

  it('prints the repro of each cluster of the latest run, saves it next to the run, and exits 1', async () => {
    const lines = await executeMinimize(options());
    expect(lines.stderr).toBe('');
    expect(lines.exitCode).toBe(1);
    expect(lines.stdout).toMatch(new RegExp(`^cluster ${runId}/1 · candidate 1 ./bin/tool-bad · stdout number-value\nminimized ${shortCaseId(cases[0]!.id)} in \\d+ runs\n`));
    expect(lines.stdout.split('\n').slice(2).join('\n')).toBe(`repro: tool\n  stdin: "t"\nsaved .port-anything/runs/${runId}/repros/1.json\n`);
    expect(await loadRepro(project, runId, 1)).toMatchObject({
      source: cases[0]!.id,
      reproduced: true,
      exhausted: false,
      max_runs: 200,
      case: { argv: [], stdin: 't', env: {}, fixtures: {} },
    });

    const usage = await executeMinimize(options({ args: { cluster: `${runId}/2`, json: false, noSandbox: true } }));
    expect(usage.exitCode).toBe(1);
    expect(usage.stdout).toMatch(new RegExp(`^cluster ${runId}/2 · candidate 1 ./bin/tool-bad · exit 2 vs 1\nminimized ${shortCaseId(cases[2]!.id)} in \\d+ runs\nrepro: tool -x\nsaved `));
  });

  it('writes the repro with its run details as JSON with --json', async () => {
    const result = await executeMinimize(options({ args: { cluster: '1', json: true, noSandbox: true } }));
    expect(result.exitCode).toBe(1);
    const summary = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({
      address: `${runId}/1`,
      candidate: './bin/tool-bad',
      program_name: 'tool',
      signature: { fields: ['stdout'], shapes: [{ field: 'stdout', shape: 'number-value' }] },
      file: `.port-anything/runs/${runId}/repros/1.json`,
      run_id: runId,
      cluster: 1,
      reproduced: true,
      case: { argv: [], stdin: 't' },
    });
    expect(summary).toMatchObject((await loadRepro(project, runId, 1))!);
  });

  it('exits 0 and says so when the cluster no longer diverges that way', async () => {
    const fixed = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-minimize-fixed-')));
    try {
      // The same project, with the candidate fixed (a copy of the reference) since the run.
      mkdirSync(join(fixed, 'bin'));
      copyFileSync(join(project, 'bin', 'tool'), join(fixed, 'bin', 'tool'));
      copyFileSync(join(project, 'bin', 'tool'), join(fixed, 'bin', 'tool-bad'));
      cpSync(join(project, '.port-anything'), join(fixed, '.port-anything'), { recursive: true });
      const result = await executeMinimize(options({ projectDir: fixed }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `cluster ${runId}/1 · candidate 1 ./bin/tool-bad · stdout number-value\n` +
          'No case of the cluster diverges this way any more (2 runs): fixed since the run, or flaky. Run port-anything run for new clusters.\n' +
          `saved .port-anything/runs/${runId}/repros/1.json\n`,
      );
      expect(await loadRepro(fixed, runId, 1)).toMatchObject({ reproduced: false, runs: 2, case: { id: cases[0]!.id } });
    } finally {
      rmSync(fixed, { recursive: true, force: true });
    }
  });

  it('exits 3 for a cluster it cannot find or run', async () => {
    const missing = await executeMinimize(options({ args: { cluster: '9', json: false, noSandbox: true } }));
    expect(missing).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/^port-anything minimize: Run \S+ has clusters 1 to 2, so there is no cluster 9\.\n$/) });
    const gone = await executeMinimize(options({ cases: cases.slice(1) }));
    expect(gone.exitCode).toBe(3);
    expect(gone.stderr).toMatch(/the corpus no longer has/);
    const sandbox = await executeMinimize(options({ args: { cluster: '1', json: false, noSandbox: false } }));
    expect(sandbox.exitCode).toBe(3);
    expect(sandbox.stderr).toMatch(/Install bubblewrap/);
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-minimize-empty-')));
    try {
      expect((await executeMinimize(options({ projectDir: empty }))).stderr).toMatch(/No saved run yet/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('is the minimize command of the CLI, reading the project directory', async () => {
    expect(await minimizeCommand([], { cwd: project })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/Which cluster\?/) });
    // No port-anything.yaml in this project directory.
    expect(await run(['minimize', '1'], { cwd: project })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/port-anything\.yaml/) });
  });
});

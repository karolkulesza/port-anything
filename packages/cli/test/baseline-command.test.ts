import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_RECORD_FILE, cacheDir, readBaselineRecord, shortCaseId, type SandboxProbe } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baselineCommand, parseBaselineArgs } from '../src/baseline-command.js';
import { run } from '../src/run.js';
import { runCommand } from '../src/run-command.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
// A reference whose output varies between runs: each case keeps a run counter under
// $PA_TEST_COUNTERS (allow-listed in the config), so every run differs from the previous one.
const NONDETERMINISTIC = `#!/bin/sh
counter="$PA_TEST_COUNTERS/$1"
n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$counter"
case "$1" in
  stable) echo same ;;
  log) echo "[2026-10-14T08:00:$(printf %02d "$n")Z] worker pid $$ started in $(pwd)" >&2; echo done ;;
  list) case $((n % 3)) in 0) printf 'apple\\nfig\\npear\\n' ;; 1) printf 'fig\\npear\\napple\\n' ;; *) printf 'pear\\napple\\nfig\\n' ;; esac ;;
  random) echo "token \${n}" ;;
esac
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

const CONFIG = `# Nondeterministic fixture
version: 1
reference: { cmd: ./bin/tool }
candidate: { cmd: ./bin/tool-copy }
sandbox:
  env_allowlist: [PA_TEST_COUNTERS]
normalizers:
  - ansi-codes   # kept as written
`;

describe('parseBaselineArgs', () => {
  it('reads --repeats and --no-sandbox', () => {
    expect(parseBaselineArgs(['--repeats', '5', '--no-sandbox'])).toEqual({ repeats: 5, noSandbox: true });
    expect(parseBaselineArgs([])).toEqual({ noSandbox: false });
  });

  it('rejects fewer than 2 repeats and unknown options', () => {
    expect(() => parseBaselineArgs(['--repeats', '1'])).toThrow(/at least 2/);
    expect(() => parseBaselineArgs(['--repeats=x'])).toThrow(/at least 2/);
    expect(() => parseBaselineArgs(['--json'])).toThrow(/Usage: port-anything baseline/);
  });
});

describe('baselineCommand', () => {
  let project: string;
  const ids: Record<string, string> = {};

  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-baseline-')));
    mkdirSync(join(project, 'bin'));
    mkdirSync(join(project, 'counters'));
    for (const file of ['tool', 'tool-copy']) writeFileSync(join(project, 'bin', file), NONDETERMINISTIC, { mode: 0o755 });
    process.env.PA_TEST_COUNTERS = join(project, 'counters');
    writeFileSync(join(project, 'port-anything.yaml'), CONFIG);
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(
      join(project, 'port-anything', 'recorded', 'cases.jsonl'),
      ['stable', 'log', 'list', 'random'].map((name) => `{"argv":["${name}"],"features":["cmd.${name}"],"origin":"recorded"}\n`).join(''),
    );
  });
  afterAll(() => {
    delete process.env.PA_TEST_COUNTERS;
    rmSync(project, { recursive: true, force: true });
  });

  it('adds the proposed normalizers to port-anything.yaml and lists the flaky-reference cases', async () => {
    const result = await baselineCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const record = (await readBaselineRecord(project))!;
    expect(record.repeats).toBe(3);
    expect(record.flaky_reference).toHaveLength(1);
    const random = record.flaky_reference[0]!.case;
    expect(result.stdout).toBe(
      [
        'Ran 4 cases 3 times each as "tool", sandbox: none (--no-sandbox)',
        'reference ./bin/tool',
        'stable: 1, stable after normalizers: 2, flaky-reference: 1',
        'proposed normalizers, added to port-anything.yaml (cases that need them):',
        '  tmp-paths on stderr: 1',
        '  iso-timestamps on stderr: 1',
        '  pids on stderr: 1',
        '  sort-lines on stdout for cmd.list: 1',
        'flaky-reference, left out of run (fields that still vary):',
        `  ${shortCaseId(random)}  stdout`,
        'froze 4 cases (0 generated, 4 recorded); per feature: cmd.list 1 · cmd.log 1 · cmd.random 1 · cmd.stable 1',
        'froze the corpus in .port-anything/MANIFEST.json: commit it; port-anything verify checks it',
        '',
      ].join('\n'),
    );
    expect(readFileSync(join(project, 'port-anything.yaml'), 'utf8')).toBe(
      CONFIG +
        [
          '  - { tmp-paths: null, scope: stderr } # added by port-anything baseline: needed in 1 case',
          '  - { iso-timestamps: null, scope: stderr } # added by port-anything baseline: needed in 1 case',
          '  - { pids: null, scope: stderr } # added by port-anything baseline: needed in 1 case',
          '  - { sort-lines: null, scope: stdout, features: [ cmd.list ] } # added by port-anything baseline: needed in 1 case',
          '',
        ].join('\n'),
    );
    ids.random = random;
  });

  it('proposes nothing more on a second baseline', async () => {
    const before = readFileSync(join(project, 'port-anything.yaml'), 'utf8');
    const result = await run(['baseline', '--no-sandbox', '--repeats', '2'], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ran 4 cases 2 times each');
    expect(result.stdout).toContain('stable: 3, stable after normalizers: 0, flaky-reference: 1\nproposed normalizers: none\n');
    expect(readFileSync(join(project, 'port-anything.yaml'), 'utf8')).toBe(before);
    expect((await readBaselineRecord(project))!.repeats).toBe(2);
  });

  it('then run matches a faithful copy on every case but the flaky-reference one, which it leaves out and lists', async () => {
    const result = await runCommand(['--no-sandbox', '--json'], { cwd: project, probe: NO_SANDBOX });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.cases).toBe(3);
    expect(json.flaky_reference).toEqual([{ case: ids.random, fields: ['stdout'] }]);
    expect(json.candidates[0]).toMatchObject({ match: 3, diverge: 0 });

    const text = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
    expect(text.stdout).toContain(`flaky-reference, left out (the reference varied in port-anything baseline): 1\n  ${shortCaseId(ids.random!)}  stdout\n`);
  });

  it('counts the flaky-reference case it left out in the score, report.json and the integrity panel (done when)', async () => {
    const json = JSON.parse((await runCommand(['--no-sandbox', '--json'], { cwd: project, probe: NO_SANDBOX })).stdout);
    // Every frozen case is in the counts: 3 compared, 1 left out.
    expect(json.candidates[0].score.raw).toMatchObject({ cases: 4, scored: 3, match: 3, flakyReference: 1 });
    expect(json.candidates[0].score.features.find((f: { feature: string }) => f.feature === 'cmd.random')).toMatchObject({ cases: 1, scored: 0, flakyReference: 1, parity: null });

    const text = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
    expect(text.stdout).toContain('  1 flaky-reference (not scored)\n');

    expect((await run(['report'], { cwd: project })).exitCode).toBe(0);
    const report = JSON.parse(readFileSync(join(project, 'port-anything-report.json'), 'utf8'));
    expect(report.cases).toBe(3);
    expect(report.flaky_reference).toEqual([{ case: ids.random, fields: ['stdout'] }]);
    expect(report.candidates[0].raw).toMatchObject({ cases: 4, scored: 3, flaky_reference: 1 });
    const html = readFileSync(join(project, 'port-anything-report.html'), 'utf8');
    const integrity = html.slice(html.indexOf('<section id="integrity">'));
    expect(integrity).toContain('<h3>Flaky-reference</h3>');
    expect(integrity).toContain(`<li><code>${shortCaseId(ids.random!)}</code>: stdout</li>`);
  });

  it('does not write sort-lines for cases without features, and says why', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-baseline-nofeat-')));
    try {
      mkdirSync(join(other, 'bin'));
      writeFileSync(join(other, 'bin', 'tool'), NONDETERMINISTIC, { mode: 0o755 });
      writeFileSync(join(other, 'port-anything.yaml'), CONFIG);
      mkdirSync(join(other, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(join(other, 'port-anything', 'recorded', 'cases.jsonl'), '{"argv":["list","x"],"origin":"recorded"}\n');
      const result = await baselineCommand(['--no-sandbox'], { cwd: other, probe: NO_SANDBOX });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('stable: 0, stable after normalizers: 0, flaky-reference: 1\nproposed normalizers: none\nnot proposed: sort-lines, needed in 1 case without features;');
      expect(readFileSync(join(other, 'port-anything.yaml'), 'utf8')).toBe(CONFIG);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('exits 3 for a broken record, a config it cannot use, or no sandbox', async () => {
    writeFileSync(join(cacheDir(project), BASELINE_RECORD_FILE), '{}');
    const broken = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
    expect(broken.exitCode).toBe(3);
    expect(broken.stderr).toMatch(/run port-anything baseline again/);

    const noSandbox = await baselineCommand([], { cwd: project, probe: NO_SANDBOX });
    expect(noSandbox.exitCode).toBe(3);
    expect(noSandbox.stderr).toMatch(/^port-anything baseline: No local sandbox works here/);

    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-baseline-empty-')));
    try {
      expect((await baselineCommand([], { cwd: elsewhere, probe: NO_SANDBOX })).stderr).toMatch(/No port-anything\.yaml/);
      writeFileSync(join(elsewhere, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./nope }\n');
      expect((await baselineCommand(['--no-sandbox'], { cwd: elsewhere, probe: NO_SANDBOX })).stderr).toMatch(/No cases to baseline/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, cacheDir, canonicalCase, parseConfig, shortCaseId, type CanonicalCase, type SandboxProbe } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun, parseRunArgs, runCommand, type ExecuteRunOptions } from '../src/run-command.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const TOOL = (variant: 'ref' | 'good' | 'bad') => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${variant === 'bad' ? 'cat' : "tr 'a-z' 'A-Z'"} ;;
  fail) echo "$(basename "$0"): no" >&2; exit ${variant === 'bad' ? 2 : 1} ;;
  self) echo "$0" ;;
  warn) echo "${variant === 'ref' ? 'tool: x: cannot open' : variant === 'good' ? 'tool-copy:  x: cannot open ' : 'error: no such thing'}" >&2; exit 1 ;;
esac
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('parseRunArgs', () => {
  it('reads repeated --candidate, --json and --no-sandbox', () => {
    expect(parseRunArgs(['--candidate', './a', '--candidate=coreutils sort', '--json', '--no-sandbox'])).toEqual({
      candidates: ['./a', 'coreutils sort'],
      json: true,
      noSandbox: true,
    });
    expect(parseRunArgs([])).toEqual({ candidates: [], json: false, noSandbox: false });
  });

  it('says which documented options are not available yet, and rejects unknown ones', () => {
    expect(() => parseRunArgs(['--smoke'])).toThrow(/--smoke is not available yet/);
    expect(() => parseRunArgs(['--feature', 'x'])).toThrow(/--feature is not available yet/);
    expect(() => parseRunArgs(['--frobnicate'])).toThrow(/frobnicate/);
    expect(() => parseRunArgs(['extra'])).toThrow(/extra/);
  });
});

describe('executeRun', () => {
  let project: string;
  let cases: CanonicalCase[];

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-run-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    const store = new BlobStore(cacheDir(project));
    const input = await store.put('hello\n');
    cases = [{ argv: ['echo', 'hi'] }, { argv: ['upper'], stdin: input }, { argv: ['fail'] }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const options = (over: Partial<ExecuteRunOptions> = {}): ExecuteRunOptions => ({
    projectDir: project,
    config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidates: [{ cmd: './bin/tool-copy' }, { cmd: ['./bin/tool-bad'] }] }),
    cases,
    args: { candidates: [], json: false, noSandbox: true },
    probe: NO_SANDBOX,
    ...over,
  });

  it('prints each candidate with its diverging cases, and exits 1 when any diverges', async () => {
    const result = await executeRun(options());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      [
        'Ran 3 cases as "tool", sandbox: none (--no-sandbox)',
        'reference ./bin/tool',
        'compare standard (stderr loose, similarity 0.6)',
        'normalizers: none',
        'candidate 1 ./bin/tool-copy: 3 of 3 cases match',
        'candidate 2 ./bin/tool-bad: 1 of 3 cases match, 2 diverge',
        `  ${shortCaseId(cases[1]!.id)}  stdout`,
        `  ${shortCaseId(cases[2]!.id)}  exit`,
        '',
      ].join('\n'),
    );
    expect(result.stderr).toBe('');
  });

  it('gives the same verdicts for 2 candidates as for two separate runs (done when)', async () => {
    const json = { candidates: [], json: true, noSandbox: true };
    const both = JSON.parse((await executeRun(options({ args: json }))).stdout);
    const config = (cmd: string) => parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd } });
    const copy = JSON.parse((await executeRun(options({ args: json, config: config('./bin/tool-copy') }))).stdout);
    const bad = JSON.parse((await executeRun(options({ args: json, config: config('./bin/tool-bad') }))).stdout);
    expect(both.candidates).toEqual([...copy.candidates, ...bad.candidates]);
    expect(both.candidates[1].divergences).toHaveLength(2);
  });

  it('writes JSON with --json', async () => {
    const result = await executeRun(options({ args: { candidates: [], json: true, noSandbox: true } }));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      program_name: 'tool',
      sandbox: 'none (--no-sandbox)',
      reference: './bin/tool',
      compare: { profile: 'standard', stderr: { mode: 'loose', similarity: 0.6 } },
      cases: 3,
      normalizers: [],
      candidates: [
        { command: './bin/tool-copy', match: 3, diverge: 0, normalizers: [], divergences: [] },
        {
          command: './bin/tool-bad',
          match: 1,
          diverge: 2,
          normalizers: [],
          divergences: [
            { case: cases[1]!.id, fields: ['stdout'] },
            { case: cases[2]!.id, fields: ['exit'] },
          ],
        },
      ],
    });
  });

  it('runs the --candidate programs instead of the configured ones, and exits 0 when all match', async () => {
    const result = await executeRun(options({ args: { candidates: ['./bin/tool-copy'], json: false, noSandbox: true } }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('candidate 1 ./bin/tool-copy: 3 of 3 cases match\n');
    expect(result.stdout).not.toContain('tool-bad');
  });

  it('cleans up its scratch directory', async () => {
    await executeRun(options());
    expect(readdirSync(join(project, '.port-anything'))).not.toContain('tmp');
  });

  it('refuses to run without a sandbox unless --no-sandbox is given, printing the fix (exit 3)', async () => {
    const result = await executeRun(options({ args: { candidates: [], json: false, noSandbox: false } }));
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/No local sandbox works here/);
    expect(result.stderr).toMatch(/Install bubblewrap/);
  });

  it('exits 3 with a message for what it cannot run', async () => {
    const noCandidate = await executeRun(options({ config: parseConfig({ version: 1, reference: { cmd: './bin/tool' } }) }));
    expect(noCandidate).toMatchObject({ exitCode: 3, stdout: '' });
    expect(noCandidate.stderr).toMatch(/No candidate to run/);

    const missing = await executeRun(options({ args: { candidates: ['./bin/nope'], json: false, noSandbox: true } }));
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toMatch(/nope not found/);

    const container = await executeRun(
      options({ config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-copy' }, sandbox: { mode: 'container' } }) }),
    );
    expect(container.exitCode).toBe(3);
    expect(container.stderr).toMatch(/sandbox mode "container" is not available yet/);

    const noCases = await executeRun(options({ cases: [] }));
    expect(noCases.exitCode).toBe(3);
    expect(noCases.stderr).toMatch(/No cases to run/);
  });
});

describe('executeRun profiles', () => {
  let project: string;
  let warn: CanonicalCase[];
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-profile-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    warn = [canonicalCase({ argv: ['warn'], origin: 'recorded' })];
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const run = (compare: unknown, json = false) =>
    executeRun({
      projectDir: project,
      config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidates: [{ cmd: './bin/tool-copy' }, { cmd: './bin/tool-bad' }], compare }),
      cases: warn,
      args: { candidates: [], json, noSandbox: true },
      probe: NO_SANDBOX,
    });

  it('compares under the configured profile and says which one', async () => {
    // tool-copy prints the same message under its own file name with other spacing; tool-bad another message.
    const standard = await run(undefined);
    expect(standard.stdout).toContain('compare standard (stderr loose, similarity 0.6)\n');
    expect(standard.stdout).toContain('candidate 1 ./bin/tool-copy: 1 of 1 cases match\ncandidate 2 ./bin/tool-bad: 0 of 1 cases match, 1 diverge\n');
    expect(standard.stdout).toMatch(/c_[0-9a-f]{8} {2}stderr\n$/);

    const strict = await run({ profile: 'strict' });
    expect(strict.stdout).toContain('compare strict (stderr exact)\nnormalizers: none\ncandidate 1 ./bin/tool-copy: 0 of 1 cases match, 1 diverge\n');

    const lenient = await run({ profile: 'lenient' });
    expect(lenient.exitCode).toBe(0);
    expect(lenient.stdout).toContain('compare lenient (stderr ignored)\n');

    const json = JSON.parse((await run({ fields: { stderr: { similarity: 0.8 } } }, true)).stdout);
    expect(json.compare).toEqual({ profile: 'standard', stderr: { mode: 'loose', similarity: 0.8 } });
    expect(JSON.parse((await run({ profile: 'lenient' }, true)).stdout).compare).toEqual({ profile: 'lenient' });
  });
});

describe('runCommand', () => {
  it('reads port-anything.yaml and the committed cases from the project directory', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-runcmd-')));
    try {
      mkdirSync(join(project, 'bin'));
      writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
      writeFileSync(join(project, 'bin', 'tool-bad'), TOOL('bad'), { mode: 0o755 });
      writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-bad }\n');
      mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), '{"argv":["upper"],"stdin":"hello\\n","origin":"recorded"}\n');
      const result = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/candidate 1 \.\/bin\/tool-bad: 0 of 1 cases match, 1 diverge\n {2}c_[0-9a-f]{8} {2}stdout\n$/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('applies the configured normalizers and prints how many cases each changed', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-runcmd-')));
    try {
      mkdirSync(join(project, 'bin'));
      writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
      writeFileSync(join(project, 'bin', 'tool-copy'), TOOL('good'), { mode: 0o755 });
      writeFileSync(join(project, 'bin', 'tool-bad'), TOOL('bad'), { mode: 0o755 });
      const config = (normalizers: string) =>
        `version: 1\nreference: { cmd: ./bin/tool }\ncandidates: [{ cmd: ./bin/tool-copy }, { cmd: ./bin/tool-bad }]\n${normalizers}`;
      mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
      // Each side runs from its own program directory, so `self` ($0) differs until tmp-paths replaces it.
      writeFileSync(
        join(project, 'port-anything', 'recorded', 'cases.jsonl'),
        ['self', 'echo'].map((cmd) => `{"argv":["${cmd}","x"],"origin":"recorded"}`).join('\n'),
      );

      writeFileSync(join(project, 'port-anything.yaml'), config(''));
      const raw = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
      expect(raw.stdout).toContain('normalizers: none\ncandidate 1 ./bin/tool-copy: 1 of 2 cases match, 1 diverge\n');

      writeFileSync(join(project, 'port-anything.yaml'), config('normalizers:\n  - tmp-paths\n  - { iso-timestamps: null, scope: stderr }\n'));
      const result = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        ['normalizers (cases changed):', '  tmp-paths: 1', '  iso-timestamps on stderr: 0', 'candidate 1 ./bin/tool-copy: 2 of 2 cases match', ''].join('\n'),
      );
      const json = JSON.parse((await runCommand(['--no-sandbox', '--json'], { cwd: project, probe: NO_SANDBOX })).stdout);
      expect(json.normalizers).toEqual([
        { normalizer: 'tmp-paths', cases: 1 },
        { normalizer: 'iso-timestamps on stderr', cases: 0 },
      ]);
      expect(json.candidates.map((c: { normalizers: unknown }) => c.normalizers)).toEqual([json.normalizers, json.normalizers]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('exits 3 for bad arguments, a bad config or a broken case file', async () => {
    const project = mkdtempSync(join(tmpdir(), 'pa-cli-runcmd-'));
    try {
      expect((await runCommand(['--smoke'], { cwd: project })).stderr).toMatch(/--smoke is not available yet/);
      writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./ref }\ncandidate: { cmd: ./port }\n');
      mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(join(project, 'port-anything', 'recorded', 'x.jsonl'), '{"argv":[]}\n');
      const broken = await runCommand([], { cwd: project, probe: NO_SANDBOX });
      expect(broken).toMatchObject({ exitCode: 3, stdout: '' });
      expect(broken.stderr).toMatch(/port-anything\/recorded\/x\.jsonl:1: origin/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

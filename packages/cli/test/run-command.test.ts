import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, RUN_ID_PATTERN, cacheDir, canonicalCase, loadRun, parseConfig, runsDir, shortCaseId, type CanonicalCase, type SandboxProbe } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun, parseRunArgs, runCommand, type ExecuteRunOptions } from '../src/run-command.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const TOOL = (variant: 'ref' | 'good' | 'bad') => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${variant === 'bad' ? 'cat' : "tr 'a-z' 'A-Z'"} ;;
  fail) echo "$(basename "$0"): no" >&2; exit ${variant === 'bad' ? 2 : 1} ;;
  self) echo "$0" ;;
  nap) ${variant === 'bad' ? 'sleep 5' : 'true'} ;;
  warn) echo "${variant === 'ref' ? 'tool: x: cannot open' : variant === 'good' ? 'tool-copy:  x: cannot open ' : 'error: no such thing'}" >&2; exit 1 ;;
esac
`;

/** Text output with the run ID, which differs on every run, replaced. */
const stable = (stdout: string) => stdout.replace(/^run \d{8}-\d{6}-[0-9a-f]{4}/m, 'run <id>');

/** Text output without each candidate's parity lines, for tests about other parts of it. */
const unscored = (stdout: string) => stdout.replace(/^ {2}(parity|by origin|under-sampled|self-description|untested|\d+ (waived|flaky|timed)).*\n/gm, '');

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('parseRunArgs', () => {
  it('reads repeated --candidate, --cluster, --json and --no-sandbox', () => {
    expect(parseRunArgs(['--candidate', './a', '--candidate=coreutils sort', '--cluster', '20261014-190203-a1b2/2', '--json', '--no-sandbox'])).toEqual({
      candidates: ['./a', 'coreutils sort'],
      cluster: '20261014-190203-a1b2/2',
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

  it('prints each candidate with its diverging cases in clusters, and exits 1 when any diverges', async () => {
    const result = await executeRun(options());
    expect(result.exitCode).toBe(1);
    expect(stable(result.stdout)).toBe(
      [
        'Ran 3 cases as "tool", sandbox: none (--no-sandbox)',
        'run <id>',
        'reference ./bin/tool',
        'compare standard (stderr loose, similarity 0.6)',
        'normalizers: none',
        'candidate 1 ./bin/tool-copy: 3 of 3 cases match',
        '  parity n/a: no feature has 20 scored cases (corpus.min_cases_per_feature)',
        '  under-sampled, not in the parity: base 100.0% (3 cases)',
        'candidate 2 ./bin/tool-bad: 1 of 3 cases match, 2 diverge',
        '  parity n/a: no feature has 20 scored cases (corpus.min_cases_per_feature)',
        '  under-sampled, not in the parity: base 33.3% (3 cases)',
        '  cluster 1: 1 case · exit 1 vs 2 · features base (1)',
        `    ${shortCaseId(cases[2]!.id)}`,
        '  cluster 2: 1 case · stdout other · features base (1)',
        `    ${shortCaseId(cases[1]!.id)}`,
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
    const json = JSON.parse(result.stdout);
    expect(json).toEqual({
      run_id: expect.stringMatching(RUN_ID_PATTERN),
      subset: null,
      program_name: 'tool',
      sandbox: 'none (--no-sandbox)',
      reference: './bin/tool',
      compare: { profile: 'standard', stderr: { mode: 'loose', similarity: 0.6 } },
      cases: 3,
      normalizers: [],
      candidates: [
        { command: './bin/tool-copy', match: 3, diverge: 0, score: expect.objectContaining({ headline: null, underSampled: ['base'] }), normalizers: [], divergences: [] },
        {
          command: './bin/tool-bad',
          match: 1,
          diverge: 2,
          score: expect.objectContaining({ headline: null, raw: expect.objectContaining({ scored: 3, match: 1 }) }),
          normalizers: [],
          divergences: [
            { case: cases[1]!.id, fields: ['stdout'] },
            { case: cases[2]!.id, fields: ['exit'] },
          ],
        },
      ],
      clusters: [
        {
          cluster: 1,
          candidate: 2,
          signature: { fields: ['exit'], shapes: [{ field: 'exit', shape: 'exit-code', detail: '1 vs 2' }] },
          features: [{ feature: 'base', cases: 1 }],
          size: 1,
          weight: 1 / 3,
          cases: [cases[2]!.id],
        },
        {
          cluster: 2,
          candidate: 2,
          signature: { fields: ['stdout'], shapes: [{ field: 'stdout', shape: 'other' }] },
          features: [{ feature: 'base', cases: 1 }],
          size: 1,
          weight: 1 / 3,
          cases: [cases[1]!.id],
        },
      ],
    });
    // Saved as printed, with each candidate as configured.
    const { version, created, candidate_commands, ...saved } = await loadRun(project, json.run_id);
    expect(saved).toEqual(json);
    expect([version, candidate_commands]).toEqual([1, ['./bin/tool-copy', ['./bin/tool-bad']]]);
    expect(Date.parse(created)).toBeGreaterThan(Date.now() - 60_000);
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
    const standard = await run(undefined).then((r) => ({ ...r, stdout: unscored(r.stdout) }));
    expect(standard.stdout).toContain('compare standard (stderr loose, similarity 0.6)\n');
    expect(standard.stdout).toContain('candidate 1 ./bin/tool-copy: 1 of 1 cases match\ncandidate 2 ./bin/tool-bad: 0 of 1 cases match, 1 diverge\n');
    expect(standard.stdout).toMatch(/\n {2}cluster 1: 1 case · stderr message-text · features base \(1\)\n {4}c_[0-9a-f]{8}\n$/);

    const strict = await run({ profile: 'strict' }).then((r) => ({ ...r, stdout: unscored(r.stdout) }));
    expect(strict.stdout).toContain('compare strict (stderr exact)\nnormalizers: none\ncandidate 1 ./bin/tool-copy: 0 of 1 cases match, 1 diverge\n');

    const lenient = await run({ profile: 'lenient' });
    expect(lenient.exitCode).toBe(0);
    expect(lenient.stdout).toContain('compare lenient (stderr ignored)\n');

    const json = JSON.parse((await run({ fields: { stderr: { similarity: 0.8 } } }, true)).stdout);
    expect(json.compare).toEqual({ profile: 'standard', stderr: { mode: 'loose', similarity: 0.8 } });
    expect(JSON.parse((await run({ profile: 'lenient' }, true)).stdout).compare).toEqual({ profile: 'lenient' });
  });
});

describe('executeRun clusters', () => {
  let project: string;
  let cases: CanonicalCase[];
  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-clusters-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    const store = new BlobStore(cacheDir(project));
    // tool-bad gets `upper` wrong (7 of the 10 opt.u cases) and `fail`'s exit code (the only error case).
    const upper = await Promise.all('abcdefg'.split('').map(async (w) => ({ argv: ['upper'], stdin: await store.put(`${w}\n`), features: ['opt.u'] })));
    const echo = ['x', 'y', 'z'].map((w) => ({ argv: ['echo', w], features: ['opt.u'] }));
    cases = [...upper, ...echo, { argv: ['fail'], features: ['error'] }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const exec = (args: Partial<ExecuteRunOptions['args']> = {}, over: Partial<ExecuteRunOptions> = {}) =>
    executeRun({
      projectDir: project,
      config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidates: [{ cmd: './bin/tool-copy' }, { cmd: ['./bin/tool-bad'] }] }),
      cases,
      args: { candidates: [], json: false, noSandbox: true, ...args },
      probe: NO_SANDBOX,
      ...over,
    });
  const json = async (args: Partial<ExecuteRunOptions['args']> = {}, over: Partial<ExecuteRunOptions> = {}) => {
    const result = await exec({ ...args, json: true }, over);
    return { exitCode: result.exitCode, ...JSON.parse(result.stdout) };
  };

  it('ranks clusters by size × feature weight and lists at most 5 cases of each', async () => {
    // The exit cluster is all of `error` (weight 1); the stdout cluster 7 of the 10 opt.u cases (0.7).
    const result = await exec();
    const ids = cases.slice(0, 5).map((c) => shortCaseId(c.id));
    expect(unscored(result.stdout)).toContain(
      [
        'candidate 2 ./bin/tool-bad: 3 of 11 cases match, 8 diverge',
        '  cluster 1: 1 case · exit 1 vs 2 · features error (1)',
        `    ${shortCaseId(cases[10]!.id)}`,
        '  cluster 2: 7 cases · stdout other · features opt.u (7)',
        `    ${ids.join('  ')}  … and 2 more`,
        '',
      ].join('\n'),
    );
    const { clusters } = await json();
    expect(clusters.map((c: { size: number; weight: number }) => [c.size, c.weight])).toEqual([
      [1, 1],
      [7, expect.closeTo(0.7)],
    ]);
    expect(clusters[1].cases).toEqual(cases.slice(0, 7).map((c) => c.id));
  });

  it('re-runs one cluster against its candidate, or the --candidate given, without changing the latest run', async () => {
    const full = await json();
    const two = await json({ cluster: '2' });
    expect(two).toMatchObject({ exitCode: 1, subset: { cluster: `${full.run_id}/2` }, cases: 7, candidates: [{ command: './bin/tool-bad', diverge: 7 }] });
    expect(two.run_id).not.toBe(full.run_id);
    // Weighed against the cases run: here the cluster is all of opt.u.
    expect(two.clusters).toEqual([{ ...full.clusters[1], cluster: 1, candidate: 1, weight: expect.closeTo(1) }]);

    const text = await exec({ cluster: `${full.run_id}/1` });
    expect(text.stdout).toMatch(new RegExp(`^Ran 1 case as "tool", sandbox: none \\(--no-sandbox\\)\nrun \\S+, cluster ${full.run_id}/1 only\n`));

    const fixed = await exec({ cluster: '2', candidates: ['./bin/tool-copy'] });
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout).toContain('candidate 1 ./bin/tool-copy: 7 of 7 cases match\n');

    // The cluster runs were saved, but the latest run of the whole corpus is still the full one.
    expect((await json({ cluster: '1' })).subset).toEqual({ cluster: `${full.run_id}/1` });
    expect((await loadRun(project, two.run_id)).subset).toEqual({ cluster: `${full.run_id}/2` });
  });

  it('exits 3 for a cluster it cannot find, or whose cases the corpus no longer has', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-clusters-')));
    try {
      expect(await exec({ cluster: '1' }, { projectDir: empty })).toMatchObject({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/No saved run yet/) });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const { run_id: runId } = await json();
    expect((await exec({ cluster: '3' })).stderr).toBe(`port-anything run: Run ${runId} has clusters 1 to 2, so there is no cluster 3.\n`);
    expect((await exec({ cluster: 'one' })).stderr).toMatch(/"one" is not a cluster/);
    const gone = await exec({ cluster: '2' }, { cases: cases.slice(3) });
    expect(gone.exitCode).toBe(3);
    expect(gone.stderr).toMatch(new RegExp(`Cluster ${runId}/2 has 3 cases that the corpus no longer has \\(c_`));
  });
});

describe('executeRun scores', () => {
  let project: string;
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-score-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const run = async (cases: CanonicalCase[], yaml: Record<string, unknown> = {}) => {
    const config = parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-bad' }, ...yaml });
    const args = { candidates: [], noSandbox: true };
    const options = { projectDir: project, config, cases, probe: NO_SANDBOX };
    const text = await executeRun({ ...options, args: { ...args, json: false } });
    const json = JSON.parse((await executeRun({ ...options, args: { ...args, json: true } })).stdout);
    return { text: text.stdout, score: json.candidates[0].score };
  };
  const echo = (n: number, features: string[], origin: 'recorded' | 'generated' = 'recorded') =>
    Array.from({ length: n }, (_, i) => canonicalCase({ argv: ['echo', `${features.join(' ')} ${i}`], features, origin }));

  it('scores 100% when the only difference is in a self-description feature, listed on its own line', async () => {
    // tool-bad fails `fail`; tagged opt.help here, it stands for a --help text that differs.
    const help = canonicalCase({ argv: ['fail'], features: ['opt.help'], origin: 'recorded' });
    const { text, score } = await run([...echo(2, ['opt.a']), ...echo(2, ['opt.b'], 'generated'), help], { corpus: { min_cases_per_feature: 2 } });
    expect(text).toContain(
      [
        'candidate 1 ./bin/tool-bad: 4 of 5 cases match, 1 diverge',
        '  parity 100.0%, mean of 2 features (4 of 5 scored cases match)',
        '  by origin: recorded 100.0% (3 cases), generated 100.0% (2 cases)',
        '  self-description, not in the parity: opt.help 0.0% (1 case)',
        '',
      ].join('\n'),
    );
    expect(score).toMatchObject({ headline: 1, headlineFeatures: ['opt.a', 'opt.b'], selfDescription: ['opt.help'], minCasesPerFeature: 2 });
  });

  it('takes the mean over features, so many cheap error cases do not inflate it', async () => {
    const errors = Array.from({ length: 30 }, (_, i) => canonicalCase({ argv: ['echo', `error ${i}`], features: ['error.usage'], origin: 'recorded' }));
    const store = new BlobStore(cacheDir(project));
    const upper = await Promise.all(['a', 'b', 'c', 'd'].map(async (w) => canonicalCase({ argv: ['upper'], stdin: await store.put(`${w}\n`), features: ['opt.u'], origin: 'recorded' })));
    const { text, score } = await run([...errors, ...upper, ...echo(1, ['opt.x'])], { corpus: { min_cases_per_feature: 4 } });
    expect(text).toContain('  parity 50.0%, mean of 2 features (31 of 35 scored cases match)\n  under-sampled, not in the parity: opt.x 100.0% (1 case)\n');
    expect(score.raw.parity).toBeCloseTo(31 / 35);
  });

  it('counts a candidate timeout as a divergence and says so', async () => {
    const nap = canonicalCase({ argv: ['nap'], origin: 'recorded' });
    const { text, score } = await run([nap, ...echo(1, [])], { corpus: { min_cases_per_feature: 1 }, sandbox: { timeout: '500ms' } });
    expect(text).toContain('  parity 50.0%, mean of 1 feature (1 of 2 scored cases match)\n  1 timed out (diverge)\n');
    expect(score.raw).toMatchObject({ diverge: 1, timeouts: 1 });
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
      expect(unscored(result.stdout)).toMatch(/candidate 1 \.\/bin\/tool-bad: 0 of 1 cases match, 1 diverge\n {2}cluster 1: 1 case · stdout other · features base \(1\)\n {4}c_[0-9a-f]{8}\n$/);
      const runId = /^run (\S+)$/m.exec(result.stdout)![1]!;
      expect((await loadRun(project, runId)).clusters).toHaveLength(1);
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

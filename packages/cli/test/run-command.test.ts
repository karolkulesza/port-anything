import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlobStore,
  blobRef,
  RUN_ID_PATTERN,
  cacheDir,
  writeBaselineRecord,
  canonicalCase,
  describeSignature,
  findContainerEngine,
  historyPath,
  inlineCase,
  latestRun,
  loadRun,
  parseConfig,
  parseWaivers,
  readHistory,
  runsDir,
  saveRepro,
  shortCaseId,
  type CanonicalCase,
  type SandboxProbe,
} from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unknownFeatureTagsWarning } from '../src/corpus.js';
import { REPORT_JSON_FILE } from '../src/report-command.js';
import { executeRun, parseRunArgs, runCommand, type ExecuteRunOptions } from '../src/run-command.js';
import { run as cli } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const engine = await findContainerEngine().catch(() => undefined);

const TOOL = (variant: 'ref' | 'good' | 'bad') => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${variant === 'bad' ? 'cat' : "tr 'a-z' 'A-Z'"} ;;
  fail) echo "$(basename "$0"): no" >&2; exit ${variant === 'bad' ? 2 : 1} ;;
  self) echo "$0" ;;
  nap) ${variant === 'bad' ? 'sleep 5' : 'true'} ;;
  hang) sleep 5 ;;
  both) echo ${variant === 'bad' ? 2 : 1}; exit ${variant === 'bad' ? 3 : 0} ;;
  warn) echo "${variant === 'ref' ? 'tool: x: cannot open' : variant === 'good' ? 'tool-copy:  x: cannot open ' : 'error: no such thing'}" >&2; exit 1 ;;
esac
`;

// A racy port: every other run of a command gets upper wrong. Its run counts live in $PA_TEST_STATE.<command>.
const RACY = `#!/bin/sh
state="$PA_TEST_STATE.$1"
n=$(cat "$state" 2>/dev/null || echo 0)
echo $((n + 1)) > "$state"
case "$1" in
  echo) shift; echo "$@" ;;
  upper) if [ $((n % 2)) = 0 ]; then cat; else tr 'a-z' 'A-Z'; fi ;;
  fail) echo "$(basename "$0"): no" >&2; exit 1 ;;
esac
`;

// A port that stalls on its first `upper`, as a starved machine makes any program do, then answers rightly.
const STALL = `#!/bin/sh
state="$PA_TEST_STATE.$1"
n=$(cat "$state" 2>/dev/null || echo 0)
echo $((n + 1)) > "$state"
case "$1" in
  echo) shift; echo "$@" ;;
  upper) if [ "$n" = 0 ]; then exec sleep 10; fi; tr 'a-z' 'A-Z' ;;
  fail) echo "$(basename "$0"): no" >&2; exit 1 ;;
esac
`;

/** Text output with the run ID, which differs on every run, replaced. */
const stable = (stdout: string) => stdout.replace(/^run \d{8}-\d{6}-[0-9a-f]{4}/m, 'run <id>');

/** Text output without each candidate's parity lines, for tests about other parts of it. */
const unscored = (stdout: string) => stdout.replace(/^ {2}(parity|by origin|under-sampled|self-description|untested|slowdown|\d+ (waived|flaky|timed|timeout)).*\n/gm, '');

/** The line a run of the whole corpus ends with in a project without a CLI spec. */
const NO_HOLDOUT = 'fresh holdout: not run, no port-anything/cli-spec.yaml to generate cases from (port-anything spec infer writes one)';

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('parseRunArgs', () => {
  it('reads repeated --candidate, --cluster or --smoke, --json and --no-sandbox', () => {
    expect(parseRunArgs(['--candidate', './a', '--candidate=coreutils sort', '--cluster', '20261014-190203-a1b2/2', '--json', '--no-sandbox'])).toEqual({
      candidates: ['./a', 'coreutils sort'],
      cluster: '20261014-190203-a1b2/2',
      smoke: false,
      json: true,
      noSandbox: true,
    });
    expect(parseRunArgs([])).toEqual({ candidates: [], smoke: false, json: false, noSandbox: false });
    expect(parseRunArgs(['--smoke'])).toEqual({ candidates: [], smoke: true, json: false, noSandbox: false });
    expect(parseRunArgs(['--feature', 'opt.n'])).toEqual({ candidates: [], feature: 'opt.n', smoke: false, json: false, noSandbox: false });
    expect(() => parseRunArgs(['--smoke', '--cluster', '2'])).toThrow(/--smoke, --cluster and --feature run different subsets/);
    expect(() => parseRunArgs(['--feature', 'x', '--cluster', '2'])).toThrow(/run different subsets/);
    expect(() => parseRunArgs(['--feature='])).toThrow(/--feature needs a feature name/);
  });

  it('reads --holdout N, 0 for none, with a run of the whole corpus only', () => {
    expect(parseRunArgs(['--holdout', '250'])).toEqual({ candidates: [], smoke: false, holdout: 250, json: false, noSandbox: false });
    expect(parseRunArgs(['--holdout=0']).holdout).toBe(0);
    for (const bad of ['-1', '1.5', 'many', '']) expect(() => parseRunArgs([`--holdout=${bad}`]), bad).toThrow(/--holdout takes a number of cases/);
    expect(() => parseRunArgs(['--holdout', '10', '--smoke'])).toThrow(/--holdout goes with a run of the whole corpus/);
    expect(() => parseRunArgs(['--cluster', '2', '--holdout', '10'])).toThrow(/--holdout goes with a run of the whole corpus/);
    expect(() => parseRunArgs(['--holdout', '10', '--feature', 'opt.n'])).toThrow(/--holdout goes with a run of the whole corpus, not with --smoke, --cluster or --feature/);
  });

  it('says which documented options are not available yet, and rejects unknown ones', () => {
    expect(() => parseRunArgs(['--all'])).toThrow(/--all is not available yet/);
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
    writeFileSync(join(project, 'bin', 'tool-racy'), RACY, { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-stall'), STALL, { mode: 0o755 });
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
        '  parity n/a: no feature outside self-description has 20 scored cases (corpus.min_cases_per_feature)',
        '  under-sampled, not in the parity: base 100.0% (3 cases)',
        'candidate 2 ./bin/tool-bad: 1 of 3 cases match, 2 diverge',
        '  parity n/a: no feature outside self-description has 20 scored cases (corpus.min_cases_per_feature)',
        '  under-sampled, not in the parity: base 33.3% (3 cases)',
        '  cluster 1: 1 case · exit 1 vs 2 · features base (1)',
        `    ${shortCaseId(cases[2]!.id)}`,
        '  cluster 2: 1 case · stdout other · features base (1)',
        `    ${shortCaseId(cases[1]!.id)}`,
        NO_HOLDOUT,
        "what a cluster's cases do differently: port-anything run --cluster <n>, or port-anything report",
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
      flaky_reference: [],
      normalizers: [],
      waivers: [],
      holdout: { ran: false, reason: expect.stringMatching(/^no port-anything\/cli-spec\.yaml/) },
      candidates: [
        {
          command: './bin/tool-copy',
          match: 3,
          diverge: 0,
          waived: 0,
          score: expect.objectContaining({ headline: null, underSampled: ['base'] }),
          normalizers: [],
          waivers: [],
          divergences: [],
          flaky_candidate: [],
          timeout_recovered: [],
          waived_cases: [],
        },
        {
          command: './bin/tool-bad',
          match: 1,
          diverge: 2,
          waived: 0,
          score: expect.objectContaining({ headline: null, raw: expect.objectContaining({ scored: 3, match: 1 }) }),
          normalizers: [],
          waivers: [],
          divergences: [
            { case: cases[1]!.id, fields: ['stdout'], outputs: [{ field: 'stdout', reference: blobRef('HELLO\n'), candidate: blobRef('hello\n') }] },
            { case: cases[2]!.id, fields: ['exit'], outputs: [{ field: 'exit', reference: '1', candidate: '2' }] },
          ],
          flaky_candidate: [],
          timeout_recovered: [],
          waived_cases: [],
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

  it('scores a case on the candidate re-run when its first run timed out, and lists it as recovered', { timeout: 60_000 }, async () => {
    let state = 0;
    const stall = (json: boolean) =>
      executeRun(
        options({
          config: parseConfig({
            version: 1,
            reference: { cmd: './bin/tool' },
            candidate: { cmd: './bin/tool-stall' },
            sandbox: { timeout: '2s', env: { PA_TEST_STATE: join(project, `stall-state-${state++}`) } },
          }),
          args: { candidates: [], json, noSandbox: true },
        }),
      );
    const text = await stall(false);
    expect(text.exitCode).toBe(0);
    expect(stable(text.stdout)).toBe(
      [
        'Ran 3 cases as "tool", sandbox: none (--no-sandbox)',
        'run <id>',
        'reference ./bin/tool',
        'compare standard (stderr loose, similarity 0.6)',
        'normalizers: none',
        'candidate 1 ./bin/tool-stall: 3 of 3 cases match',
        '  parity n/a: no feature outside self-description has 20 scored cases (corpus.min_cases_per_feature)',
        '  1 timeout, recovered on re-run',
        '  under-sampled, not in the parity: base 100.0% (3 cases)',
        '  timeout, recovered on re-run (the re-run was compared):',
        `    ${shortCaseId(cases[1]!.id)}`,
        NO_HOLDOUT,
        '',
      ].join('\n'),
    );
    const json = JSON.parse((await stall(true)).stdout);
    expect(json.candidates[0]).toMatchObject({
      match: 3,
      diverge: 0,
      score: { raw: { scored: 3, match: 3, timeouts: 0, timeoutRecovered: 1 } },
      divergences: [],
      flaky_candidate: [],
      timeout_recovered: [{ case: cases[1]!.id }],
    });
  });

  it('lists the flaky-candidate cases of a racy port apart and counts them as diverging (done when)', async () => {
    let state = 0;
    const racy = (json: boolean) =>
      executeRun(
        options({
          config: parseConfig({
            version: 1,
            reference: { cmd: './bin/tool' },
            candidates: [{ cmd: './bin/tool-copy' }, { cmd: './bin/tool-racy' }],
            sandbox: { env: { PA_TEST_STATE: join(project, `racy-state-${state++}`) } },
          }),
          args: { candidates: [], json, noSandbox: true },
        }),
      );
    const text = await racy(false);
    expect(text.exitCode).toBe(1);
    expect(stable(text.stdout)).toBe(
      [
        'Ran 3 cases as "tool", sandbox: none (--no-sandbox)',
        'run <id>',
        'reference ./bin/tool',
        'compare standard (stderr loose, similarity 0.6)',
        'normalizers: none',
        'candidate 1 ./bin/tool-copy: 3 of 3 cases match',
        '  parity n/a: no feature outside self-description has 20 scored cases (corpus.min_cases_per_feature)',
        '  under-sampled, not in the parity: base 100.0% (3 cases)',
        'candidate 2 ./bin/tool-racy: 2 of 3 cases match, 1 diverge (1 flaky-candidate)',
        '  parity n/a: no feature outside self-description has 20 scored cases (corpus.min_cases_per_feature)',
        '  1 flaky-candidate (diverge)',
        '  under-sampled, not in the parity: base 66.6% (3 cases)',
        '  flaky-candidate, a re-run gave a different result:',
        `    ${shortCaseId(cases[1]!.id)}  stdout`,
        NO_HOLDOUT,
        '',
      ].join('\n'),
    );
    const json = JSON.parse((await racy(true)).stdout);
    expect(json.candidates[1]).toEqual({
      command: './bin/tool-racy',
      match: 2,
      diverge: 1,
      waived: 0,
      score: expect.objectContaining({ raw: expect.objectContaining({ scored: 3, match: 2, flakyCandidate: 1 }) }),
      normalizers: [],
      waivers: [],
      divergences: [],
      flaky_candidate: [{ case: cases[1]!.id, fields: ['stdout'] }],
      timeout_recovered: [],
      waived_cases: [],
    });
    // Kept out of the clusters, which only hold steady divergences.
    expect(json.clusters).toEqual([]);
    // Scores lower than the faithful port, not 2 of 2 as it would if flaky cases were dropped.
    expect(json.candidates[1].match / json.cases).toBeLessThan(json.candidates[0].match / json.cases);
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

    // In sandbox mode local, run builds nothing: a missing program with a build command names it.
    const unbuilt = (config: object, candidates: string[] = []) =>
      executeRun(options({ config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, ...config }), args: { candidates, json: false, noSandbox: true } }));
    const cargo = 'cargo build --release --manifest-path port/Cargo.toml';
    const hint = (key: string) => `Build it with \`${cargo}\` (${key} in port-anything.yaml; only sandbox mode container runs the build commands).`;
    const single = await unbuilt({ candidate: { cmd: './port/target/release/tool', build: cargo } });
    expect(single).toEqual({ exitCode: 3, stdout: '', stderr: `port-anything run: Program ${join(project, 'port/target/release/tool')} not found. ${hint('candidate.build')}\n` });
    const listed = await unbuilt({ candidates: [{ cmd: './bin/tool-copy' }, { cmd: ['./port/tool', '--quiet'], build: cargo }] });
    expect(listed.stderr).toContain(`port/tool not found. ${hint('candidates.1.build')}\n`);
    const reference = await unbuilt({ reference: { cmd: './ref/tool', build: cargo }, candidate: { cmd: './bin/tool-copy' } });
    expect(reference.stderr).toContain(`ref/tool not found. ${hint('reference.build')}\n`);
    // Without a build command, for a candidate given only on the command line, or for a malformed command, no hint.
    expect(await unbuilt({ candidate: { cmd: "./port/tool 'x", build: cargo } })).toEqual({ exitCode: 3, stdout: '', stderr: "port-anything run: Unclosed ' quote in the program command: ./port/tool 'x\n" });
    expect((await unbuilt({ candidate: { cmd: './port/tool' } })).stderr).toMatch(/port\/tool not found\.\n$/);
    expect((await unbuilt({ candidate: { cmd: './bin/tool-copy', build: cargo } }, ['./port/tool'])).stderr).toMatch(/port\/tool not found\.\n$/);

    // Container mode: --no-sandbox doesn't apply, and a bare name would be the host's program.
    const container = (cmd: string, noSandbox: boolean) =>
      executeRun(
        options({
          config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd }, sandbox: { mode: 'container' } }),
          args: { candidates: [], json: false, noSandbox },
        }),
      );
    expect(await container('./bin/tool-copy', true)).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/--no-sandbox is for sandbox mode local/) });
    expect(await container('tool-copy', false)).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/In sandbox mode "container", give each program as a path \(\.\/tool-copy/) });

    const noCases = await executeRun(options({ cases: [] }));
    expect(noCases.exitCode).toBe(3);
    expect(noCases.stderr).toMatch(/No cases to run/);
  });

  // Real containers: wherever Docker or Podman answers, and always in CI on Linux.
  it.runIf(engine !== undefined || (process.env.CI !== undefined && process.platform === 'linux'))(
    'in sandbox mode container, runs reference.build and the configured candidate.build in the image first, and exits 3 when one fails',
    async () => {
      // Each build leaves a file only the image has (/etc/debian_version), so a build on the host would fail.
      const config = (referenceBuild: string) =>
        parseConfig({
          version: 1,
          reference: { cmd: './bin/tool', build: referenceBuild },
          candidate: { cmd: './bin/tool-copy', build: 'cp /etc/debian_version built-candidate' },
          sandbox: { mode: 'container', image: 'debian:12-slim' },
        });
      const container = (referenceBuild: string) => executeRun(options({ config: config(referenceBuild), args: { candidates: [], json: false, noSandbox: false } }));
      const built = await container('cp /etc/debian_version built-reference');
      expect(built.stderr).toBe('');
      expect(built.exitCode).toBe(0);
      expect(built.stdout).toContain('sandbox: container (');
      expect([existsSync(join(project, 'built-reference')), existsSync(join(project, 'built-candidate'))]).toEqual([true, true]);

      const failed = await container('echo no compiler >&2; exit 1');
      expect(failed).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(/^port-anything run: reference\.build failed in the image debian:12-slim: echo no compiler >&2; exit 1\nno compiler/) });
    },
    120_000,
  );
});

describe('executeRun waivers', () => {
  let project: string;
  let cases: CanonicalCase[];
  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-waivers-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    const store = new BlobStore(cacheDir(project));
    // tool-bad: `upper` diverges in stdout, `fail` in its exit code, `warn` in its message, `both` in stdout and exit code.
    const input = await store.put('hello\n');
    cases = [
      { argv: ['echo', 'hi'] },
      { argv: ['upper'], stdin: input, features: ['opt.u'] },
      { argv: ['fail'], features: ['error'] },
      { argv: ['warn'], features: ['error'] },
      { argv: ['both'], features: ['opt.b'] },
    ].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const run = async (waivers: unknown[], json = true) => {
    const result = await executeRun({
      projectDir: project,
      config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidates: [{ cmd: './bin/tool-copy' }, { cmd: './bin/tool-bad' }] }),
      cases,
      waivers: parseWaivers(waivers),
      args: { candidates: [], json, noSandbox: true },
      probe: NO_SANDBOX,
    });
    return json ? { exitCode: result.exitCode, ...JSON.parse(result.stdout) } : result;
  };
  const w = (match: object, category = 'intentional', reason = 'on purpose') => ({ match, category, reason });

  it('leaves a waived case out of the score and the clusters, never counting it as a match', async () => {
    const json = await run([w({ feature: 'opt.u', field: 'stdout', shape: 'other' })]);
    const bad = json.candidates[1];
    expect(bad).toMatchObject({ match: 1, diverge: 3, waived: 1, waived_cases: [{ case: cases[1]!.id, waivers: [1] }] });
    expect(bad.divergences.map((d: { case: string }) => d.case)).toEqual([cases[2]!.id, cases[3]!.id, cases[4]!.id]);
    expect(bad.score.raw).toMatchObject({ cases: 5, scored: 4, match: 1, waived: 1 });
    expect(bad.score.features.find((f: { feature: string }) => f.feature === 'opt.u')).toMatchObject({ cases: 1, scored: 0, waived: 1, parity: null });
    expect(json.clusters.flatMap((k: { cases: string[] }) => k.cases)).not.toContain(cases[1]!.id);
    expect(json.waivers).toEqual([w({ feature: 'opt.u', field: 'stdout', shape: 'other' })]);
  });

  it('waives fields, not cases: a case still diverges in the fields no waiver covers, and is clustered on them', async () => {
    const json = await run([w({ field: 'stdout' })]);
    const bad = json.candidates[1];
    expect(bad.divergences.find((d: { case: string }) => d.case === cases[4]!.id)).toEqual({
      case: cases[4]!.id,
      fields: ['exit'],
      waived_fields: ['stdout'],
      outputs: [{ field: 'exit', reference: '0', candidate: '3' }],
    });
    const both = json.clusters.find((k: { cases: string[] }) => k.cases.includes(cases[4]!.id));
    expect(both.signature).toEqual({ fields: ['exit'], shapes: [{ field: 'exit', shape: 'exit-code', detail: '0 vs 3' }] });
    // It covers a field of 2 of the 5 cases: more than 10%.
    expect(bad.waivers).toEqual([{ waiver: 1, cases: 2, share: 0.4, large: true }]);
    expect(json.candidates[0].waivers).toEqual([{ waiver: 1, cases: 0, share: 0, large: false }]);
  });

  it("matches a regex against the reference's output only, and exits 0 once every divergence is waived", async () => {
    // The reference says `tool: x: cannot open`, tool-bad `error: no such thing`.
    const theirs = await run([w({ field: 'stderr', regex: '^error: ' })]);
    expect(theirs.candidates[1].waived).toBe(0);
    const ours = await run([w({ field: 'stderr', regex: '^tool: ' }, 'platform')]);
    expect(ours.candidates[1].waived_cases).toEqual([{ case: cases[3]!.id, waivers: [1] }]);

    const all = [w({ field: 'stdout' }), w({ feature: 'error' }, 'reference-bug', 'the reference is wrong here'), w({ feature: 'opt.b', shape: 'exit-code' })];
    const result = await run(all, false);
    expect(result.exitCode).toBe(0);
    expect(unscored(result.stdout)).toContain(
      [
        'waivers (port-anything/waivers.yaml):',
        '  1. field stdout (intentional): on purpose',
        '  2. feature error (reference-bug): the reference is wrong here',
        '  3. feature opt.b, shape exit-code (intentional): on purpose',
        'candidate 1 ./bin/tool-copy: 5 of 5 cases match',
        '  waivers (cases covered): 1: 0, 2: 0, 3: 0',
        'candidate 2 ./bin/tool-bad: 1 of 5 cases match, 4 waived',
        '  waivers (cases covered): 1: 2 (40.0%, more than 10% of the cases), 2: 2 (40.0%, more than 10% of the cases), 3: 1 (20.0%, more than 10% of the cases)',
        '',
      ].join('\n'),
    );
    expect(result.stdout).toContain('  4 waived (not scored)\n');
  });

  it('never waives a candidate that timed out where the reference finished', async () => {
    const result = await executeRun({
      projectDir: project,
      config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-bad' }, sandbox: { timeout: '1s' } }),
      cases: [canonicalCase({ argv: ['nap'], origin: 'recorded' })],
      waivers: parseWaivers([w({ feature: 'base' })]),
      args: { candidates: [], json: true, noSandbox: true },
      probe: NO_SANDBOX,
    });
    const bad = JSON.parse(result.stdout).candidates[0];
    expect(result.exitCode).toBe(1);
    expect(bad).toMatchObject({ diverge: 1, waived: 0, waivers: [{ waiver: 1, cases: 0 }] });
    expect(bad.score.raw).toMatchObject({ timeouts: 1, waived: 0 });
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
    expect(standard.stdout).toMatch(/\n {2}cluster 1: 1 case · stderr message-text · features base \(1\)\n {4}c_[0-9a-f]{8}\nfresh holdout: not run, .*\nwhat a cluster's cases do differently: .*\n$/);

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

  it('keeps both sides of every divergence, and a cluster run shows the diff of its first case', async () => {
    const full = await exec();
    expect(full.stdout).toContain("what a cluster's cases do differently: port-anything run --cluster <n>, or port-anything report\n");
    expect(full.stdout).not.toContain('reference -, candidate +');
    const { candidates } = await json();
    expect(candidates[1].divergences.find((d: { case: string }) => d.case === cases[10]!.id).outputs).toEqual([{ field: 'exit', reference: '1', candidate: '2' }]);
    // Of cluster 2's 7 cases only the first and the smallest (here the same one) keep their outputs.
    const kept = candidates[1].divergences.filter((d: { outputs?: unknown }) => d.outputs !== undefined).map((d: { case: string }) => d.case);
    expect(kept.sort()).toEqual([cases[0]!.id, cases[10]!.id].sort());

    const one = await exec({ cluster: '1' });
    expect(one.stdout).toContain([`    ${shortCaseId(cases[10]!.id)}, reference -, candidate + (after normalizers):`, '      exit: reference 1, candidate 2', ''].join('\n'));
    const two = await exec({ cluster: '2' });
    expect(two.stdout).toContain([`    ${shortCaseId(cases[0]!.id)}, reference -, candidate + (after normalizers):`, '      stdout:', '        @@ line 1', '        - A', '        + a', ''].join('\n'));
    expect(two.stdout).not.toContain("what a cluster's cases do differently");
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

describe('executeRun history', () => {
  let project: string;
  let outside: string;
  let head: string;
  let cases: CanonicalCase[];

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-history-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-history-outside-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    writeFileSync(join(outside, 'tool-bad'), TOOL('bad'), { mode: 0o755 });
    git('init', '-q', '-b', 'main');
    git('add', 'bin');
    git('commit', '-q', '-m', 'tools');
    head = git('rev-parse', 'HEAD').trim();
    const store = new BlobStore(cacheDir(project));
    const input = await store.put('hello\n');
    cases = [{ argv: ['echo', 'hi'] }, { argv: ['upper'], stdin: input }, { argv: ['fail'] }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const options = (args: Partial<ExecuteRunOptions['args']> = {}): ExecuteRunOptions => ({
    projectDir: project,
    config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidates: [{ cmd: './bin/tool-copy' }, { cmd: [join(outside, 'tool-bad')] }], corpus: { min_cases_per_feature: 1 } }),
    cases,
    args: { candidates: [], json: true, noSandbox: true, ...args },
    probe: NO_SANDBOX,
  });

  it('appends each run of the whole corpus with every candidate\'s parity and git commit, but not a cluster re-run', async () => {
    expect(existsSync(historyPath(project))).toBe(false);
    const first = JSON.parse((await executeRun(options())).stdout);
    const again = JSON.parse((await executeRun(options())).stdout);
    await executeRun(options({ cluster: '1' }));
    const { entries, damaged } = await readHistory(project);
    expect(damaged).toEqual([]);
    expect(entries.map((e) => e.run_id)).toEqual([first.run_id, again.run_id]);
    expect(entries[0]).toEqual({
      version: 1,
      run_id: first.run_id,
      created: (await loadRun(project, first.run_id)).created,
      cases: 3,
      candidates: [
        { command: './bin/tool-copy', sha: head, parity: 1, features: 1, scored: 3, match: 3 },
        // Outside any git repository: no commit to record.
        { command: [join(outside, 'tool-bad')], sha: null, parity: 1 / 3, features: 1, scored: 3, match: 1 },
      ],
    });
  });

  it('records the commit checked out when the run happened', async () => {
    copyFileSync(join(project, 'bin', 'tool-copy'), join(project, 'bin', 'tool-copy2'));
    git('add', 'bin');
    git('commit', '-q', '-m', 'another copy');
    const next = git('rev-parse', 'HEAD').trim();
    const { run_id: runId } = JSON.parse((await executeRun(options({ candidates: ['./bin/tool-copy2'] }))).stdout);
    const last = (await readHistory(project)).entries.at(-1)!;
    expect(last).toMatchObject({ run_id: runId, candidates: [{ command: './bin/tool-copy2', sha: next, parity: 1 }] });
    expect(next).not.toBe(head);
  });

  it('records the script\'s commit, not the interpreter\'s, for a candidate run by a program on the PATH', async () => {
    // An interpreter installed inside a git repository of its own, as nvm and Homebrew do.
    const interpreter = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-history-interp-')));
    const savedPath = process.env.PATH;
    try {
      writeFileSync(join(interpreter, 'fake-sh'), '#!/bin/sh\nexec sh "$@"\n', { mode: 0o755 });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: interpreter, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'interpreter'], {
        cwd: interpreter,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
      process.env.PATH = `${interpreter}:${savedPath}`;
      const script = join(project, 'bin', 'tool-copy');
      const projectHead = git('rev-parse', 'HEAD').trim();
      const { run_id: runId } = JSON.parse((await executeRun(options({ candidates: [`fake-sh ${script}`] }))).stdout);
      const last = (await readHistory(project)).entries.at(-1)!;
      expect(last).toMatchObject({ run_id: runId, candidates: [{ command: `fake-sh ${script}`, sha: projectHead }] });

      // With no file among its arguments, nothing says where the candidate comes from.
      writeFileSync(join(interpreter, 'fake-copy'), TOOL('good'), { mode: 0o755 });
      await executeRun(options({ candidates: ['fake-copy'] }));
      expect((await readHistory(project)).entries.at(-1)!.candidates).toMatchObject([{ command: 'fake-copy', sha: null }]);
    } finally {
      process.env.PATH = savedPath;
      rmSync(interpreter, { recursive: true, force: true });
    }
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

  it('counts a candidate timeout as a divergence and says so, unless the reference timed out too', async () => {
    const nap = canonicalCase({ argv: ['nap'], origin: 'recorded' });
    const hang = canonicalCase({ argv: ['hang'], origin: 'recorded' });
    const { text, score } = await run([nap, hang, ...echo(1, [])], { corpus: { min_cases_per_feature: 1 }, sandbox: { timeout: '500ms' } });
    expect(text).toContain('  parity 66.6%, mean of 1 feature (2 of 3 scored cases match)\n  1 timed out (diverge)\n');
    expect(score.raw).toMatchObject({ match: 2, diverge: 1, timeouts: 1 });
  });

  it('rounds the parity down, so only a full match shows 100.0%', async () => {
    const store = new BlobStore(cacheDir(project));
    const upper = canonicalCase({ argv: ['upper'], stdin: await store.put('a\n'), features: ['opt.a'], origin: 'recorded' });

    // 2 of 3 is 66.67%: rounding to the nearest would show 66.7%.
    const { text } = await run([...echo(2, ['opt.a']), upper], { corpus: { min_cases_per_feature: 1 } });
    expect(text).toContain('  parity 66.6%, mean of 1 feature (2 of 3 scored cases match)\n');
  });

  it('says why there is no parity when only self-description features have enough cases', async () => {
    const { text } = await run(echo(2, ['opt.help']), { corpus: { min_cases_per_feature: 2 } });
    expect(text).toContain('  parity n/a: no feature outside self-description has 2 scored cases (corpus.min_cases_per_feature)\n  self-description, not in the parity: opt.help 100.0% (2 cases)\n');
  });
});

describe('executeRun slowdown gate', () => {
  let project: string;
  let cases: CanonicalCase[];
  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-slow-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
    // A deliberately slow port: right on every case, but it naps first, long enough that a slow
    // reference spawn on a loaded machine can't bring the ratio under the 2x gate.
    writeFileSync(join(project, 'bin', 'tool-slow'), TOOL('ref').replace('\n', '\nsleep 1.5\n'), { mode: 0o755 });
    const store = new BlobStore(cacheDir(project));
    const input = await store.put('hello\n');
    cases = [{ argv: ['echo', 'hi'] }, { argv: ['upper'], stdin: input }, { argv: ['fail'] }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const run = async (compare: Record<string, unknown>, json = false) => {
    const config = parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-slow' }, compare });
    return executeRun({ projectDir: project, config, cases, args: { candidates: [], json, noSandbox: true }, probe: NO_SANDBOX });
  };

  it('fails a run whose candidate matches every case but is slower than compare.max_slowdown (done when)', async () => {
    const result = await run({ max_slowdown: '2x' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('candidate 1 ./bin/tool-slow: 3 of 3 cases match\n');
    expect(result.stdout).toMatch(/^ {2}slowdown \d+\.\d\dx \(median of 3 cases\), above compare\.max_slowdown 2x$/m);

    const json = JSON.parse((await run({ max_slowdown: '2x' }, true)).stdout);
    expect(json.candidates[0]).toMatchObject({ match: 3, diverge: 0, slowdown: { cases: 3, max: 2, exceeded: true } });
    expect(json.candidates[0].slowdown.ratio).toBeGreaterThan(2);
  });

  it('passes the same port when it is within the limit, and has no gate without one', async () => {
    const within = await run({ max_slowdown: '1000x' });
    expect(within.exitCode).toBe(0);
    expect(within.stdout).toMatch(/^ {2}slowdown \d+\.\d\dx \(median of 3 cases\), within compare\.max_slowdown 1000x$/m);

    const ungated = await run({});
    expect(ungated.exitCode).toBe(0);
    expect(ungated.stdout).not.toContain('slowdown');
    expect(JSON.parse((await run({}, true)).stdout).candidates[0]).not.toHaveProperty('slowdown');
  });
});

describe('executeRun compare.min_parity gate', () => {
  let project: string;
  let cases: CanonicalCase[];
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-minparity-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), '#!/bin/sh\necho "$1"\n', { mode: 0o755 });
    // Right on 9 of the 10 cases: parity 90%.
    writeFileSync(join(project, 'bin', 'tool-port'), '#!/bin/sh\n[ "$1" = a9 ] && echo wrong || echo "$1"\n', { mode: 0o755 });
    cases = Array.from({ length: 10 }, (_, n) => canonicalCase({ argv: [`a${n}`], features: ['f'], origin: 'recorded' }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const run = async (compare: Record<string, unknown>, args: Partial<ExecuteRunOptions['args']> = {}) => {
    const config = parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-port' }, compare, corpus: { min_cases_per_feature: 1 } });
    return executeRun({ projectDir: project, config, cases, args: { candidates: [], json: false, noSandbox: true, ...args }, probe: NO_SANDBOX });
  };

  it('passes a full run whose parity meets compare.min_parity, though a case diverges', async () => {
    const met = await run({ min_parity: 0.85 });
    expect(met.stdout).toContain('candidate 1 ./bin/tool-port: 9 of 10 cases match, 1 diverge\n  parity 90.0%');
    expect(met.stdout).toMatch(/^ {2}compare\.min_parity 85\.0%: met$/m);
    expect(met.exitCode).toBe(0);
  });

  it('fails a full run whose parity is below it, and any run with a divergence without one', async () => {
    const below = await run({ min_parity: 0.95 });
    expect(below.stdout).toMatch(/^ {2}BELOW compare\.min_parity 95\.0%: the run fails$/m);
    expect(below.exitCode).toBe(1);
    const ungated = await run({});
    expect(ungated.stdout).not.toContain('min_parity');
    expect(ungated.exitCode).toBe(1);
  });

  it('leaves a smoke run, whose parity is of a subset, failing on any divergence', async () => {
    const smoke = await run({ min_parity: 0.5 }, { smoke: true });
    expect(smoke.stdout).not.toContain('min_parity');
    expect(smoke.exitCode).toBe(1);
  });

  it('refuses a threshold outside 0 to 1', () => {
    expect(() => parseConfig({ version: 1, reference: { cmd: './bin/tool' }, compare: { min_parity: 95 } })).toThrow(/min_parity/);
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
      expect(unscored(result.stdout)).toMatch(/candidate 1 \.\/bin\/tool-bad: 0 of 1 cases match, 1 diverge\n {2}cluster 1: 1 case · stdout other · features base \(1\)\n {4}c_[0-9a-f]{8}\nfresh holdout: not run, .*\nwhat a cluster's cases do differently: .*\n$/);
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

  it('reads port-anything/waivers.yaml, and exits 3 when it is not valid', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-runcmd-')));
    try {
      mkdirSync(join(project, 'bin'));
      writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
      writeFileSync(join(project, 'bin', 'tool-bad'), TOOL('bad'), { mode: 0o755 });
      writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-bad }\n');
      mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
      writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), '{"argv":["upper"],"stdin":"hello\\n","origin":"recorded"}\n');
      writeFileSync(join(project, 'port-anything', 'waivers.yaml'), '- match: { field: stdout, shape: other }\n  category: intentional\n  reason: upper-casing is out of scope\n');
      const result = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('  1. field stdout, shape other (intentional): upper-casing is out of scope\ncandidate 1 ./bin/tool-bad: 0 of 1 cases match, 1 waived\n');

      writeFileSync(join(project, 'port-anything', 'waivers.yaml'), '- match: {}\n  category: intentional\n  reason: everything\n');
      const broken = await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
      expect(broken).toMatchObject({ exitCode: 3, stdout: '' });
      expect(broken.stderr).toMatch(/^port-anything run: port-anything\/waivers\.yaml is not valid:\n {2}0\.match: needs at least one of/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('exits 3 for bad arguments, a bad config or a broken case file', async () => {
    const project = mkdtempSync(join(tmpdir(), 'pa-cli-runcmd-'));
    try {
      expect((await runCommand(['--all'], { cwd: project })).stderr).toMatch(/--all is not available yet/);
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

describe('executeRun --smoke', () => {
  let project: string;
  let store: BlobStore;
  let cases: CanonicalCase[];
  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-smoke-')));
    mkdirSync(join(project, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(project, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    store = new BlobStore(cacheDir(project));
    // tool-bad gets every `upper` case (opt.u) and the one `fail` case (error) wrong; `echo` (opt.e) is right.
    const upper = await Promise.all(Array.from({ length: 80 }, async (_, i) => ({ argv: ['upper'], stdin: await store.put(`w${i}\n`), features: ['opt.u'] })));
    const echo = Array.from({ length: 20 }, (_, i) => ({ argv: ['echo', `e${i}`], features: ['opt.e'] }));
    cases = [...upper, ...echo, { argv: ['fail'], features: ['error'] }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const exec = (args: Partial<ExecuteRunOptions['args']> = {}) =>
    executeRun({
      projectDir: project,
      config: parseConfig({ version: 1, reference: { cmd: './bin/tool' }, candidate: { cmd: './bin/tool-bad' } }),
      cases,
      args: { candidates: [], json: false, noSandbox: true, ...args },
      probe: NO_SANDBOX,
    });
  const json = async (args: Partial<ExecuteRunOptions['args']> = {}) => {
    const result = await exec({ ...args, json: true });
    return { exitCode: result.exitCode, ...JSON.parse(result.stdout) };
  };

  it('runs N cases per feature and a sample of the rest before any full run, and still catches a bad port', async () => {
    const smoke = await json({ smoke: true });
    expect(smoke).toMatchObject({ exitCode: 1, subset: { smoke: { from: null, corpus: 101, clusters: 0, per_feature: 11, passing: 50 } }, cases: 61 });
    expect(smoke.clusters.map((c: { signature: unknown }) => describeSignature(c.signature as never))).toEqual(['stdout other', 'exit 1 vs 2']);
    // A smoke run is not a full run.
    expect(await latestRun(project)).toBeUndefined();
  });

  it("takes each open cluster's repro, or its smallest case, and samples passing cases only from those that passed", async () => {
    const full = await json();
    expect(full.clusters.map((c: { size: number }) => c.size)).toEqual([80, 1]);
    // Cluster 1's repro: a case the corpus doesn't have.
    const repro = canonicalCase({ argv: ['upper'], stdin: await store.put('q'), features: ['opt.u'], origin: 'recorded' });
    await saveRepro(project, { run_id: full.run_id, cluster: 1, source: cases[0]!.id, reproduced: true, runs: 5, max_runs: 200, exhausted: false, case: await inlineCase(repro, store) });

    const smoke = await json({ smoke: true });
    // The fail case stands for cluster 2, and also for `error`; the 15 echo cases not picked by feature are the passing ones.
    expect(smoke).toMatchObject({ exitCode: 1, subset: { smoke: { from: full.run_id, corpus: 101, clusters: 2, per_feature: 10, passing: 15 } }, cases: 27 });
    const diverging = smoke.candidates[0].divergences.map((d: { case: string }) => d.case);
    expect(diverging.slice(0, 2)).toEqual([repro.id, cases[100]!.id]);
    expect(diverging).toHaveLength(2 + 5);
    expect((await latestRun(project))?.run_id).toBe(full.run_id);

    const text = await exec({ smoke: true });
    expect(text.stdout).toMatch(
      new RegExp(`^Ran 27 cases as "tool", sandbox: none \\(--no-sandbox\\)\nrun \\S+, smoke subset of 101 cases: 2 for the open clusters of run ${full.run_id}, 10 by feature, 15 passing\n`),
    );
    // A cluster of the smoke run can be re-run, its repro included.
    const stdoutCluster = smoke.clusters.find((c: { cases: string[] }) => c.cases.includes(repro.id));
    const again = await json({ cluster: `${smoke.run_id}/${stdoutCluster.cluster}` });
    expect(again).toMatchObject({ exitCode: 1, cases: 6 });
    expect(again.candidates[0].divergences.map((d: { case: string }) => d.case)).toContain(repro.id);
  }, 30_000);

  it('refuses --smoke with --cluster (exit 3)', async () => {
    expect(await exec({ smoke: true, cluster: '1' })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/--smoke, --cluster and --feature run different subsets/) });
  });

  it('runs the cases of one feature as a subset run', async () => {
    const before = (await latestRun(project))?.run_id;
    const run = await json({ feature: 'opt.e' });
    expect(run).toMatchObject({ exitCode: 0, subset: { feature: 'opt.e' }, cases: 20 });
    expect((await latestRun(project))?.run_id).toBe(before);
    expect((await exec({ feature: 'error' })).stdout).toMatch(/^run \S+, feature error only\n/m);
    const unknown = await exec({ feature: 'opt.zzz' });
    expect(unknown).toMatchObject({ exitCode: 3, stderr: expect.stringContaining('No case has feature "opt.zzz"; the corpus has error, opt.e, opt.u.') });
  });

  it('runs given cases, by ID or prefix', async () => {
    const wanted = [cases[100]!.id, shortCaseId(cases[0]!.id)];
    const run = await json({ caseIds: wanted });
    expect(run).toMatchObject({ exitCode: 1, subset: { cases: [cases[100]!.id, cases[0]!.id] }, cases: 2 });
    expect((await exec({ caseIds: [cases[100]!.id] })).stdout).toMatch(/^run \S+, 1 given case only\n/m);
    expect(await exec({ caseIds: ['c_zz'] })).toMatchObject({ exitCode: 3, stderr: expect.stringContaining('is not a case ID') });
    expect(await exec({ caseIds: ['c_1'], smoke: true })).toMatchObject({ exitCode: 3 });
  });
});

describe('run with a CLI spec that marks a flag as self-description', () => {
  // -v prints a version banner, which a port words its own way; nothing in its name says so.
  const MARKED = (variant: 'ref' | 'port') => `#!/bin/sh
case "$1" in
  -v) echo "${variant === 'ref' ? 'tool 1.0' : 'tool-port 0.1'}" ;;
  -a) shift; echo "$@" ;;
  *) cat ;;
esac
`;
  const SPEC = [
    'version: 1',
    'program: tool',
    'flags:',
    '  - { names: [-a], feature: opt.a, arity: 0 }',
    '  - { names: [-v], feature: opt.v, arity: 0, self_description: true }',
    '  - { names: [-z], feature: opt.z, arity: 0 }',
    '',
  ].join('\n');
  let project: string;
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-marked-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), MARKED('ref'), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-port'), MARKED('port'), { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nprogram_name: tool\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-port }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(join(project, 'port-anything', 'cli-spec.yaml'), SPEC);
    const cases = [
      ...Array.from({ length: 20 }, (_, i) => ({ argv: ['-a', `word ${i}`], features: ['opt.a'] })),
      ...Array.from({ length: 20 }, (_, i) => ({ argv: ['-v', `${i}`], features: ['opt.v'] })),
    ];
    writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), cases.map((c) => JSON.stringify({ ...c, origin: 'recorded' })).join('\n'));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('lists the marked flag under self-description, out of the headline, in run and report.json (done when)', async () => {
    const text = await cli(['run', '--no-sandbox', '--holdout', '0'], { cwd: project });
    expect(text.stdout).toContain(
      [
        '  parity 100.0%, mean of 1 feature (20 of 40 scored cases match)',
        '  self-description, not in the parity: opt.v 0.0% (20 cases)',
        '  untested: opt.z',
        '',
      ].join('\n'),
    );
    expect(text.stdout).not.toContain('under-sampled');

    const json = JSON.parse((await cli(['run', '--no-sandbox', '--holdout', '0', '--json'], { cwd: project })).stdout);
    expect(json.candidates[0].score).toMatchObject({ headline: 1, headlineFeatures: ['opt.a'], selfDescription: ['opt.v'], underSampled: [], untested: ['opt.z'] });

    expect((await cli(['report', '--json'], { cwd: project })).exitCode).toBe(0);
    const report = JSON.parse(readFileSync(join(project, REPORT_JSON_FILE), 'utf8'));
    const v = report.candidates[0].features.find((f: { feature: string }) => f.feature === 'opt.v');
    expect(v).toMatchObject({ self_description: true, under_sampled: false, in_headline: false });
    expect(report.candidates[0].self_description).toEqual(['opt.v']);
  });

  it('scores a subset run with the same marks, without calling the rest of the spec untested', async () => {
    const json = JSON.parse((await cli(['run', '--no-sandbox', '--feature', 'opt.v', '--json'], { cwd: project })).stdout);
    expect(json.candidates[0].score).toMatchObject({ headline: null, selfDescription: ['opt.v'], underSampled: [], untested: [] });
  });

  it('keeps the mark on a subset run whose cases of the feature were all left out as flaky-reference', async () => {
    const all = JSON.parse((await cli(['run', '--no-sandbox', '--feature', 'opt.v', '--json'], { cwd: project })).stdout);
    const ids: string[] = all.candidates[0].divergences.map((d: { case: string }) => d.case);
    expect(ids).toHaveLength(20);
    await writeBaselineRecord(project, { version: 1, repeats: 2, flaky_reference: ids.map((id) => ({ case: id, fields: ['stdout'] })) });
    try {
      const json = JSON.parse((await cli(['run', '--no-sandbox', '--feature', 'opt.v', '--json'], { cwd: project })).stdout);
      expect(json.cases).toBe(0);
      expect(json.candidates[0].score).toMatchObject({ selfDescription: ['opt.v'], underSampled: [], raw: { cases: 20, flakyReference: 20 } });
    } finally {
      rmSync(join(cacheDir(project), 'baseline.json'), { force: true });
    }
  });

  it('leaves the marked flag out of the fresh holdout parity too', { timeout: 60_000 }, async () => {
    const json = JSON.parse((await cli(['run', '--no-sandbox', '--holdout', '60', '--json'], { cwd: project })).stdout);
    expect(json.holdout).toMatchObject({ ran: true });
    const { holdout } = json.candidates[0];
    expect(holdout.diverging.length).toBeGreaterThan(0); // the -v cases it drew, which still diverge
    expect(holdout).toMatchObject({ parity: 1, features: 1 });
  });
});

describe('run and baseline with a recorded case tagged with a feature the CLI spec lacks', () => {
  let project: string;
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-unknown-tag-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nprogram_name: tool\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(join(project, 'port-anything', 'cli-spec.yaml'), 'version: 1\nprogram: tool\nflags:\n  - { names: [-s], feature: opt.s, arity: 1, values: [{ name: N, type: int }] }\n');
    const lines = [
      { argv: ['-s', '8'], features: ['opt.s'] },
      { argv: ['plain'] },
      { argv: ['-s', '-16'], features: ['opt.s', 'opt.1'] },
      { argv: ['x'], features: ['base'] },
      { argv: ['-s', '-1'], features: ['opt.1'] },
    ];
    writeFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), `${lines.map((c) => JSON.stringify({ ...c, origin: 'recorded' })).join('\n')}\n`);
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const WARNING = [
    'warning: feature tags in port-anything/recorded/ that port-anything/cli-spec.yaml does not define (a typo, or a tag of your own, scored as a feature of its own):',
    '  opt.1 · 2 cases, first at port-anything/recorded/cases.jsonl:3',
    '',
  ].join('\n');

  it('warns on run, naming the tag, its file and line (done when)', async () => {
    const result = await cli(['run', '--no-sandbox', '--holdout', '0'], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(`port-anything run: ${WARNING}`);
  });

  it('warns on baseline too (done when)', async () => {
    const result = await cli(['baseline', '--no-sandbox', '--repeats', '2'], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(`port-anything baseline: ${WARNING}`);
  });

  it('lists 10 unknown tags at most', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-many-tags-')));
    try {
      for (const f of ['bin', 'port-anything.yaml', 'port-anything']) execFileSync('cp', ['-R', join(project, f), join(other, f)]);
      const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ argv: [`a${i}`], features: [`tag${String(i).padStart(2, '0')}`], origin: 'recorded' }));
      writeFileSync(join(other, 'port-anything', 'recorded', 'cases.jsonl'), `${lines.join('\n')}\n`);
      const warning = (await unknownFeatureTagsWarning(other))!;
      expect(warning.split('\n').filter((l) => l.startsWith('  tag'))).toHaveLength(10);
      expect(warning).toContain('  tag09 · 1 case, first at port-anything/recorded/cases.jsonl:10\n  … and 2 more\n');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('says nothing when every tag is the spec\'s or base, or when there is no spec', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-known-tags-')));
    try {
      for (const f of ['bin', 'port-anything.yaml', 'port-anything']) execFileSync('cp', ['-R', join(project, f), join(other, f)]);
      writeFileSync(join(other, 'port-anything', 'recorded', 'cases.jsonl'), '{"argv":["-s","8"],"features":["opt.s"],"origin":"recorded"}\n{"argv":["x"],"features":["base"],"origin":"recorded"}\n');
      expect((await cli(['run', '--no-sandbox', '--holdout', '0'], { cwd: other })).stderr).toBe('');
      rmSync(join(other, 'port-anything', 'cli-spec.yaml'));
      writeFileSync(join(other, 'port-anything', 'recorded', 'cases.jsonl'), '{"argv":["x"],"features":["fields"],"origin":"recorded"}\n');
      expect((await cli(['run', '--no-sandbox', '--holdout', '0'], { cwd: other })).stderr).toBe('');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BlobStore,
  buildInImage,
  cacheDir,
  describeFeatures,
  describeSignature,
  ensureImage,
  findContainerEngine,
  loadCommittedCases,
  readConfigFile,
  type SavedCluster,
  type Score,
} from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The wc-lite example end to end: a C reference, its Rust port, and bad ports that are the same
// port built with one deliberate bug each (cargo features), in both sandbox modes. Local mode needs
// a C compiler and cargo; CI and the dev container have both (scripts/dev-linux.sh pnpm -r test).
// Container mode needs Docker or Podman instead: everything is built and run in a Rust image.
const exec = promisify(execFile);
const example = fileURLToPath(new URL('../../../examples/wc-lite/', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

interface Repro {
  argv: string[];
  stdin: string | null;
  env: Record<string, string>;
  fixtures: Record<string, string>;
}

interface Expected {
  /** The one cluster its divergences form, or null when they are all flaky-candidate. */
  cluster: { size: number; signature: string; features: string } | null;
  /** The minimal case the cluster minimizes to. */
  repro: Repro | null;
  /** The parity printed for it: the mean over the 8 scored features, rounded down to 0.1%. */
  parity: string;
  /** Flaky-candidate cases, and the features losing parity when its cases are not all in the cluster. */
  flaky?: { cases: number; features: string };
}

const none = { env: {}, fixtures: {} };

/**
 * Each bad port's cargo feature and what the run must find. Parities are worked out from the
 * committed corpus, e.g. off-by-one: opt.l 3/5, base 3/4, error.file 2/3 and five features at 1
 * (87.70…%); crlf: opt.L 3/4 (96.875%, shown rounded down).
 */
const BAD_PORTS: Record<string, Expected> = {
  // The lines count of input without a final newline: three cases with three different feature sets.
  'bad-off-by-one': {
    cluster: { size: 3, signature: 'stdout number-value', features: 'opt.l (2), base (1), error.file (1)' },
    // From `-l` on "one\ntwo\nthree": any input whose last line has no newline, with no option at all.
    repro: { argv: [], stdin: 't', ...none },
    parity: '87.7%',
  },
  // The longest line of CRLF input, one character short.
  'bad-crlf': {
    cluster: { size: 1, signature: 'stdout number-value', features: 'opt.L (1)' },
    // From `-L crlf.txt`: -L and the file stay, and the file is one CRLF line ending.
    repro: { argv: ['-L', 'crlf.txt'], stdin: null, env: {}, fixtures: { 'crlf.txt': '\r\n' } },
    parity: '96.8%',
  },
  'bad-exit-code': {
    cluster: { size: 3, signature: 'exit 2 vs 1', features: 'error.usage (3)' },
    // From the smallest usage error, `-x`, which has nothing to drop.
    repro: { argv: ['-x'], stdin: null, ...none },
    parity: '87.5%',
  },
  // -m is an invalid option: no output, a usage error.
  'bad-missing-flag': {
    cluster: {
      size: 3,
      signature: 'exit 0 vs 2, stdout empty (candidate empty), stderr empty (reference empty)',
      features: 'opt.m (3), opt.c (2), opt.L (1), opt.l (1), opt.w (1)',
    },
    // From `-mc` on binary input: the input goes; the one argument stays whole (tokens aren't split).
    repro: { argv: ['-mc'], stdin: null, ...none },
    parity: '70.4%',
  },
  // A tab at a tab stop doesn't move.
  'bad-rounding': {
    cluster: { size: 1, signature: 'stdout number-value', features: 'opt.L (1)' },
    // From three lines with tabs: a tab at column 0 is the whole bug.
    repro: { argv: ['-L'], stdin: '\t', ...none },
    parity: '96.8%',
  },
  // Several files are printed last to first; the lines are the same, in another order.
  'bad-ordering': {
    cluster: { size: 3, signature: 'stdout line-order', features: 'base (2), error.file (1), opt.l (1)' },
    // From `- a.txt` with text on both: two inputs are needed, empty ones do.
    repro: { argv: ['-', 'a.txt'], stdin: null, env: {}, fixtures: { 'a.txt': '' } },
    parity: '87.0%',
  },
  // -L is off by a different amount on every run: each such case is flaky-candidate, in no cluster.
  'bad-racy': {
    cluster: null,
    repro: null,
    parity: '73.5%',
    flaky: { cases: 4, features: 'opt.L (4), opt.c (1), opt.l (1), opt.m (1), opt.w (1)' },
  },
  // Errors start with "wc" instead of the name it runs as. Caught because stderr is compared exactly.
  'bad-program-name': {
    cluster: { size: 6, signature: 'stderr message-text', features: 'error.file (3), error.usage (3), opt.l (1)' },
    repro: { argv: ['-x'], stdin: null, ...none },
    parity: '72.5%',
  },
  // After `--`, -l is read as an option instead of a file name.
  'bad-double-dash': {
    cluster: { size: 1, signature: 'exit 1 vs 0, stdout empty (reference empty), stderr empty (candidate empty)', features: 'error.file (1)' },
    repro: { argv: ['--', '-l'], stdin: null, ...none },
    parity: '95.8%',
  },
  // Only a space ends a word, so the words count is off wherever a tab or a newline separates words.
  'bad-words': {
    cluster: { size: 6, signature: 'stdout number-value', features: 'opt.w (4), base (2), opt.l (2), opt.L (1), opt.c (1), opt.m (1)' },
    // A newline alone is a word.
    repro: { argv: ['a.txt'], stdin: null, env: {}, fixtures: { 'a.txt': '\n' } },
    parity: '64.7%',
  },
};
const BAD = Object.keys(BAD_PORTS);
/** The bad ports with a cluster, in candidate order: cluster n is the nth of them. */
const CLUSTERED = BAD.filter((feature) => BAD_PORTS[feature]!.cluster !== null);

const has = (cmd: string) => exec(cmd, ['--version']).then(() => true, () => false);
const toolchain = (await has('cc')) && (await has('cargo'));
// On a developer machine without the toolchain the test is skipped; in CI it must run.
const enabled = toolchain || process.env.CI !== undefined;
const sandboxed = process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1';
const engine = await findContainerEngine().catch(() => undefined);
const IMAGE = 'rust:1-slim';
const MODES = [
  { mode: 'local', enabled },
  // Wherever Docker or Podman answers, and always in CI on Linux (the runners have Docker).
  { mode: 'container', enabled: engine !== undefined || (process.env.CI !== undefined && process.platform === 'linux') },
] as const;

interface RunSummary {
  cases: number;
  candidates: { command: string; match: number; diverge: number; waived: number; score: Score; normalizers: unknown[]; waivers: unknown[]; divergences: { case: string; fields: string[] }[]; flaky_candidate: { case: string; fields: string[] }[]; timeout_recovered: { case: string }[] }[];
  clusters: SavedCluster[];
}

for (const { mode, enabled } of MODES)
describe.runIf(enabled)(`examples/wc-lite (sandbox mode ${mode})`, () => {
  let project: string;
  // In container mode cases always run in containers; locally, outside the dev container, unsandboxed.
  const noSandbox = mode === 'local' && !sandboxed ? ['--no-sandbox'] : [];
  const badPath = (feature: string) => `./port/target/${feature}/release/wc-lite`;
  const port = (...args: string[]) =>
    exec(process.execPath, [binPath, 'run', ...noSandbox, ...args], { cwd: project }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );

  const minimize = (...args: string[]) =>
    exec(process.execPath, [binPath, 'minimize', ...noSandbox, ...args], { cwd: project }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );

  // A command's JSON output; when there is none, the error says what it printed on stderr.
  const parse = <T>({ stdout, stderr }: { stdout: string; stderr: string }): T => {
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new Error(`no JSON on stdout; stderr:\n${stderr}`);
    }
  };

  beforeAll(async () => {
    if (mode === 'local' && !toolchain) throw new Error('The wc-lite example needs cc and cargo on the PATH.');
    if (mode === 'container' && engine === undefined) throw new Error('Sandbox mode container needs Docker or Podman running.');
    // Under /tmp, away from the checkout, so no build output lands in it.
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-wc-lite-')));
    cpSync(example, project, {
      recursive: true,
      filter: (src) => {
        const path = relative(example, src).split(sep).join('/');
        return !['ref/wc-lite', 'port/target', '.port-anything'].some((p) => path === p || path.startsWith(`${p}/`));
      },
    });
    if (mode === 'container') {
      const file = join(project, 'port-anything.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('\n  mode: local\n', `\n  mode: container\n  image: ${IMAGE}\n`));
    }
    // The builds the config documents, then one build per bad port.
    const config = await readConfigFile(project);
    expect(config.sandbox.mode).toBe(mode);
    const builds = [config.reference.build!, config.candidate!.build!];
    for (const feature of Object.keys(BAD_PORTS)) {
      builds.push(`cargo build --release --manifest-path port/Cargo.toml --features ${feature} --target-dir port/target/${feature}`);
    }
    if (mode === 'container') {
      // In the image, one after another (the bad ports have target dirs of their own).
      await ensureImage(engine!, IMAGE);
      const built = await buildInImage({ kind: 'container', engine: engine!, image: IMAGE }, project, builds.join(' && '));
      if (!built.ok) throw new Error(built.output);
    } else await Promise.all(builds.map((cmd) => exec('sh', ['-c', cmd], { cwd: project })));
    mkdirSync(join(project, 'copy'));
    copyFileSync(join(project, 'ref', 'wc-lite'), join(project, 'copy', 'wc-copy'));
  }, 300_000);
  afterAll(() => {
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
  });

  it('has its committed cases sorted by ID, every ID checked', async () => {
    const cases = await loadCommittedCases(project, new BlobStore(cacheDir(project)));
    const lines = readFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), 'utf8').trimEnd().split('\n');
    const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
    expect(ids).toEqual(cases.map((c) => c.id));
    expect(ids).toEqual([...ids].sort());
  });

  it('matches the reference with the Rust port as configured', async () => {
    const result = await port('--json');
    const { code } = result;
    const summary = parse<RunSummary>(result);
    expect(summary.cases).toBeGreaterThanOrEqual(20);
    expect(summary.candidates).toEqual([
      {
        command: './port/target/release/wc-lite',
        match: summary.cases,
        diverge: 0,
        waived: 0,
        score: expect.any(Object),
        normalizers: [],
        waivers: [],
        divergences: [],
        flaky_candidate: [],
        timeout_recovered: [],
        waived_cases: [],
      },
    ]);
    // The good port scores 100%, over every feature but the self-description ones.
    const { score } = summary.candidates[0]!;
    expect(score).toMatchObject({ headline: 1, selfDescription: ['help', 'version'], underSampled: [], minCasesPerFeature: 3 });
    expect(score.headlineFeatures).toEqual(['base', 'error.file', 'error.usage', 'opt.L', 'opt.c', 'opt.l', 'opt.m', 'opt.w']);
    expect(code).toBe(0);
  }, 120_000);

  it('catches every bad port: one cluster of its own each, flaky-candidate apart, none for a renamed identical copy (one run)', async () => {
    const args = ['./copy/wc-copy', ...BAD.map(badPath)].flatMap((c) => ['--candidate', c]);
    const json = await port('--json', ...args);
    const { cases, candidates, clusters } = parse<RunSummary>(json);
    expect(json.code).toBe(1);
    expect(candidates[0]).toMatchObject({ command: './copy/wc-copy', match: cases, diverge: 0 });
    const got = clusters.map((c) => ({ candidate: c.candidate, size: c.size, signature: describeSignature(c.signature), features: describeFeatures(c.features) }));
    expect(got).toEqual(CLUSTERED.map((feature) => ({ candidate: BAD.indexOf(feature) + 2, ...BAD_PORTS[feature]!.cluster })));
    for (const c of clusters) expect(c.cases).toEqual(candidates[c.candidate - 1]!.divergences.map((d) => d.case));
    for (const [i, feature] of BAD.entries()) {
      const { cluster, flaky } = BAD_PORTS[feature]!;
      const { score, diverge, flaky_candidate } = candidates[i + 1]!;
      // Caught: it diverges and loses parity, in exactly the features of its cluster (or of its flaky cases).
      expect(diverge, feature).toBeGreaterThan(0);
      expect(score.headline, feature).toBeLessThan(1);
      expect(flaky_candidate, feature).toHaveLength(flaky?.cases ?? 0);
      const hit = score.features.filter((f) => f.parity !== 1).map((f) => `${f.feature} (${f.diverge})`);
      expect(hit.sort(), feature).toEqual((cluster ?? flaky)!.features.split(', ').sort());
    }

    const text = await port(...args);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`candidate 1 ./copy/wc-copy: ${cases} of ${cases} cases match\n`);
    for (const [i, feature] of BAD.entries()) {
      const { match, diverge } = candidates[i + 1]!;
      const { cluster, parity, flaky } = BAD_PORTS[feature]!;
      const flakyNote = flaky === undefined ? '' : ` (${flaky.cases} flaky-candidate)`;
      expect(text.stdout).toContain(`candidate ${i + 2} ${badPath(feature)}: ${match} of ${cases} cases match, ${diverge} diverge${flakyNote}\n  parity ${parity}, mean of 8 features`);
      if (cluster !== null) {
        const n = CLUSTERED.indexOf(feature) + 1;
        expect(text.stdout).toContain(`  cluster ${n}: ${cluster.size} case${cluster.size === 1 ? '' : 's'} · ${cluster.signature} · features ${cluster.features}\n`);
      }
    }
    expect(text.stdout).toContain('  flaky-candidate, a re-run gave a different result:\n');
  }, 180_000);

  it('minimizes the cluster of each bad port to its expected repro and saves it with the run (done when)', async () => {
    const run = await port('--json', ...BAD.flatMap((c) => ['--candidate', badPath(c)]));
    const { run_id: runId, clusters } = parse<RunSummary & { run_id: string }>(run);
    expect(clusters.map((c) => BAD[c.candidate - 1])).toEqual(CLUSTERED);
    for (const [i, feature] of CLUSTERED.entries()) {
      const minimized = await minimize('--json', `${runId}/${i + 1}`);
      expect(minimized.code).toBe(1);
      const repro = parse<{ reproduced: boolean; exhausted: boolean; runs: number; case: { id: string } }>(minimized);
      const { id: _id, ...invocation } = repro.case;
      expect({ feature, ...invocation }).toEqual({ feature, ...BAD_PORTS[feature]!.repro });
      expect(repro).toMatchObject({ reproduced: true, exhausted: false });
      expect(repro.runs).toBeLessThanOrEqual(200);
    }
    // The text output shows the repro as a command line; the latest run is the default.
    const text = await minimize('2');
    expect(text.code).toBe(1);
    expect(text.stdout).toMatch(new RegExp(`^cluster ${runId}/2 · candidate 2 ${badPath('bad-crlf').replace(/[.]/g, '\\.')} · stdout number-value\nminimized \\S+ in \\d+ runs\nrepro: wc-lite -L crlf\\.txt\n  file crlf\\.txt: "\\\\r\\\\n"\nsaved \\.port-anything/runs/${runId}/repros/2\\.json\n$`));
  }, 300_000);

  // The smoke target is 15 s. In container mode a run usually takes 4–8 s here too, but container
  // start-up on Docker Desktop slows down a lot when the machine is busy, so the bound is looser.
  const SMOKE_BOUND_MS = mode === 'container' ? 30_000 : 15_000;
  it(`catches every bad port with run --smoke in under ${SMOKE_BOUND_MS / 1000} s, with or without its cluster open (done when)`, async () => {
    // The three bad ports this check was written for; each forms one cluster.
    const bad = ['bad-off-by-one', 'bad-crlf', 'bad-exit-code'];
    const smoke = async (...args: string[]) => {
      const start = performance.now();
      const result = await port('--smoke', '--json', ...args);
      const ms = performance.now() - start;
      expect(ms).toBeLessThan(SMOKE_BOUND_MS);
      return { code: result.code, ms, summary: parse<RunSummary & { subset: { smoke: { from: string | null; clusters: number } } }>(result) };
    };
    // The inner loop after a full run of the good port: nothing is open, so the samples must find each bug.
    expect((await port()).code).toBe(0);
    for (const feature of bad) {
      const { code, summary } = await smoke('--candidate', badPath(feature));
      expect({ feature, code, clusters: summary.subset.smoke.clusters }).toEqual({ feature, code: 1, clusters: 0 });
      expect(summary.clusters.map((c) => describeSignature(c.signature))).toContain(BAD_PORTS[feature]!.cluster!.signature);
    }

    // After a full run of the bad ports and minimizing their clusters, smoke runs each repro.
    const candidates = bad.flatMap((c) => ['--candidate', badPath(c)]);
    const run = parse<RunSummary & { run_id: string }>(await port('--json', ...candidates));
    const repros: string[] = [];
    for (const i of bad.keys()) repros.push(parse<{ case: { id: string } }>(await minimize('--json', `${run.run_id}/${i + 1}`)).case.id);
    const { code, summary } = await smoke(...candidates);
    expect(code).toBe(1);
    expect(summary.subset.smoke).toMatchObject({ from: run.run_id, clusters: 3 });
    for (const [i, feature] of bad.entries()) {
      expect({ feature, diverging: summary.candidates[i]!.divergences.map((d) => d.case) }).toEqual({ feature, diverging: expect.arrayContaining([repros[i]]) });
    }
    // The good port passes the same smoke subset.
    expect((await smoke()).code).toBe(0);
  }, 120_000);
});

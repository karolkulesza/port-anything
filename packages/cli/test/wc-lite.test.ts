import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlobStore, cacheDir, describeFeatures, describeSignature, loadCommittedCases, readConfigFile, type SavedCluster, type Score } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The wc-lite example end to end: a C reference, its Rust port, and bad ports that are the same
// port built with one deliberate bug each (cargo features). Needs a C compiler and cargo; CI and
// the dev container have both (scripts/dev-linux.sh pnpm -r test).
const exec = promisify(execFile);
const example = fileURLToPath(new URL('../../../examples/wc-lite/', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** Each bad port's cargo feature and the one cluster its divergences form. */
const BAD_PORTS = {
  // The lines count of input without a final newline: three cases with three different feature sets.
  'bad-off-by-one': { size: 3, signature: 'stdout number-value', features: 'opt.l (2), base (1), error.file (1)' },
  // The longest line of CRLF input, one character short.
  'bad-crlf': { size: 1, signature: 'stdout number-value', features: 'opt.L (1)' },
  'bad-exit-code': { size: 3, signature: 'exit 2 vs 1', features: 'error.usage (3)' },
} as const;

/** The minimal case each bad port's cluster minimizes to. */
const REPROS = {
  // From `-l` on "one\ntwo\nthree": any input whose last line has no newline, with no option at all.
  'bad-off-by-one': { argv: [], stdin: 't', env: {}, fixtures: {} },
  // From `-L crlf.txt`: -L and the file stay, and the file is one CRLF line ending.
  'bad-crlf': { argv: ['-L', 'crlf.txt'], stdin: null, env: {}, fixtures: { 'crlf.txt': '\r\n' } },
  // From the smallest usage error, `-x`, which has nothing to drop.
  'bad-exit-code': { argv: ['-x'], stdin: null, env: {}, fixtures: {} },
} as const;
type BadPort = keyof typeof BAD_PORTS;

/**
 * Each bad port's parity: the mean over 8 features of their parity. off-by-one: opt.l 3/5, base 3/4,
 * error.file 2/3, five at 1 (87.70…%); crlf: opt.L 3/4 (96.875%, shown rounded down); exit code:
 * error.usage 0/3 (87.5%).
 */
const PARITY: Record<BadPort, string> = { 'bad-off-by-one': '87.7%', 'bad-crlf': '96.8%', 'bad-exit-code': '87.5%' };

const has = (cmd: string) => exec(cmd, ['--version']).then(() => true, () => false);
const toolchain = (await has('cc')) && (await has('cargo'));
// On a developer machine without the toolchain the test is skipped; in CI it must run.
const enabled = toolchain || process.env.CI !== undefined;
const sandboxed = process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1';

interface RunSummary {
  cases: number;
  candidates: { command: string; match: number; diverge: number; score: Score; normalizers: unknown[]; divergences: { case: string; fields: string[] }[] }[];
  clusters: SavedCluster[];
}

describe.runIf(enabled)('examples/wc-lite', () => {
  let project: string;
  const badPath = (feature: BadPort) => `./port/target/${feature}/release/wc-lite`;
  const port = (...args: string[]) =>
    exec(process.execPath, [binPath, 'run', ...(sandboxed ? [] : ['--no-sandbox']), ...args], { cwd: project }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );

  const minimize = (...args: string[]) =>
    exec(process.execPath, [binPath, 'minimize', ...(sandboxed ? [] : ['--no-sandbox']), ...args], { cwd: project }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );

  beforeAll(async () => {
    if (!toolchain) throw new Error('The wc-lite example needs cc and cargo on the PATH.');
    // Under /tmp, away from the checkout, so no build output lands in it.
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-wc-lite-')));
    cpSync(example, project, {
      recursive: true,
      filter: (src) => {
        const path = relative(example, src).split(sep).join('/');
        return !['ref/wc-lite', 'port/target', '.port-anything'].some((p) => path === p || path.startsWith(`${p}/`));
      },
    });
    // The builds the config documents, then one build per bad port.
    const config = await readConfigFile(project);
    const builds = [config.reference.build!, config.candidate!.build!];
    for (const feature of Object.keys(BAD_PORTS)) {
      builds.push(`cargo build --release --manifest-path port/Cargo.toml --features ${feature} --target-dir port/target/${feature}`);
    }
    await Promise.all(builds.map((cmd) => exec('sh', ['-c', cmd], { cwd: project })));
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
    const { code, stdout } = await port('--json');
    const summary = JSON.parse(stdout) as RunSummary;
    expect(summary.cases).toBeGreaterThanOrEqual(20);
    expect(summary.candidates).toEqual([
      { command: './port/target/release/wc-lite', match: summary.cases, diverge: 0, score: expect.any(Object), normalizers: [], divergences: [], flaky_candidate: [] },
    ]);
    // The good port scores 100%, over every feature but the self-description ones.
    const { score } = summary.candidates[0]!;
    expect(score).toMatchObject({ headline: 1, selfDescription: ['help', 'version'], underSampled: [], minCasesPerFeature: 3 });
    expect(score.headlineFeatures).toEqual(['base', 'error.file', 'error.usage', 'opt.L', 'opt.c', 'opt.l', 'opt.m', 'opt.w']);
    expect(code).toBe(0);
  }, 120_000);

  it('puts the divergences of each bad port in one cluster of its own, and none for a renamed identical copy (one run)', async () => {
    const bad = Object.keys(BAD_PORTS) as BadPort[];
    const args = ['./copy/wc-copy', ...bad.map(badPath)].flatMap((c) => ['--candidate', c]);
    const json = await port('--json', ...args);
    const { cases, candidates, clusters } = JSON.parse(json.stdout) as RunSummary;
    expect(json.code).toBe(1);
    expect(candidates[0]).toMatchObject({ command: './copy/wc-copy', match: cases, diverge: 0 });
    const got = clusters.map((c) => ({ candidate: c.candidate, size: c.size, signature: describeSignature(c.signature), features: describeFeatures(c.features) }));
    expect(got).toEqual(bad.map((feature, i) => ({ candidate: i + 2, ...BAD_PORTS[feature] })));
    for (const [i, c] of clusters.entries()) expect(c.cases).toEqual(candidates[i + 1]!.divergences.map((d) => d.case));
    // Each bad port loses parity in exactly the features of its cluster.
    for (const [i, feature] of bad.entries()) {
      const { score } = candidates[i + 1]!;
      expect(score.headline).toBeLessThan(1);
      const hit = score.features.filter((f) => f.parity !== 1).map((f) => `${f.feature} (${f.diverge})`);
      expect(hit.sort()).toEqual(BAD_PORTS[feature].features.split(', ').sort());
    }

    const text = await port(...args);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`candidate 1 ./copy/wc-copy: ${cases} of ${cases} cases match\n`);
    for (const [i, feature] of bad.entries()) {
      const { match, diverge } = candidates[i + 1]!;
      const { size, signature, features } = BAD_PORTS[feature];
      expect(text.stdout).toContain(`candidate ${i + 2} ${badPath(feature)}: ${match} of ${cases} cases match, ${diverge} diverge\n  parity ${PARITY[feature]}, mean of 8 features`);
      expect(text.stdout).toContain(`  cluster ${i + 1}: ${size} case${size === 1 ? '' : 's'} · ${signature} · features ${features}\n`);
    }
  }, 120_000);

  it('minimizes the cluster of each bad port to its expected repro and saves it with the run (done when)', async () => {
    const bad = Object.keys(BAD_PORTS) as BadPort[];
    const run = await port('--json', ...bad.flatMap((c) => ['--candidate', badPath(c)]));
    const { run_id: runId, clusters } = JSON.parse(run.stdout) as RunSummary & { run_id: string };
    expect(clusters.map((c) => c.candidate)).toEqual([1, 2, 3]);
    for (const [i, feature] of bad.entries()) {
      const minimized = await minimize('--json', `${runId}/${i + 1}`);
      expect(minimized.code).toBe(1);
      const repro = JSON.parse(minimized.stdout) as { reproduced: boolean; exhausted: boolean; runs: number; case: { id: string } };
      const { id: _id, ...invocation } = repro.case;
      expect({ feature, ...invocation }).toEqual({ feature, ...REPROS[feature] });
      expect(repro).toMatchObject({ reproduced: true, exhausted: false });
      expect(repro.runs).toBeLessThanOrEqual(200);
    }
    // The text output shows the repro as a command line; the latest run is the default.
    const text = await minimize('2');
    expect(text.code).toBe(1);
    expect(text.stdout).toMatch(new RegExp(`^cluster ${runId}/2 · candidate 2 ${badPath('bad-crlf')} · stdout number-value\nminimized \\S+ in \\d+ runs\nrepro: wc-lite -L crlf\\.txt\n  file crlf\\.txt: "\\\\r\\\\n"\nsaved \\.port-anything/runs/${runId}/repros/2\\.json\n$`));
  }, 120_000);
});

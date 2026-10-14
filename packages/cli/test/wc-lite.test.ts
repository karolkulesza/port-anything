import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlobStore, cacheDir, describeFeatures, describeSignature, loadCommittedCases, readConfigFile, type SavedCluster } from '@port-anything/core';
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

const has = (cmd: string) => exec(cmd, ['--version']).then(() => true, () => false);
const toolchain = (await has('cc')) && (await has('cargo'));
// On a developer machine without the toolchain the test is skipped; in CI it must run.
const enabled = toolchain || process.env.CI !== undefined;
const sandboxed = process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1';

interface RunSummary {
  cases: number;
  candidates: { command: string; match: number; diverge: number; normalizers: unknown[]; divergences: { case: string; fields: string[] }[] }[];
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
    expect(summary.candidates).toEqual([{ command: './port/target/release/wc-lite', match: summary.cases, diverge: 0, normalizers: [], divergences: [] }]);
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

    const text = await port(...args);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`candidate 1 ./copy/wc-copy: ${cases} of ${cases} cases match\n`);
    for (const [i, feature] of bad.entries()) {
      const { match, diverge } = candidates[i + 1]!;
      const { size, signature, features } = BAD_PORTS[feature];
      const head = `candidate ${i + 2} ${badPath(feature)}: ${match} of ${cases} cases match, ${diverge} diverge\n`;
      expect(text.stdout).toContain(`${head}  cluster ${i + 1}: ${size} case${size === 1 ? '' : 's'} · ${signature} · features ${features}\n`);
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

  it('catches every bad port with run --smoke in under 15 s, with or without its cluster open (done when)', async () => {
    const bad = Object.keys(BAD_PORTS) as BadPort[];
    const smoke = async (...args: string[]) => {
      const start = performance.now();
      const result = await port('--smoke', '--json', ...args);
      const ms = performance.now() - start;
      expect(ms).toBeLessThan(15_000);
      return { code: result.code, ms, summary: JSON.parse(result.stdout) as RunSummary & { subset: { smoke: { from: string | null; clusters: number } } } };
    };
    // The inner loop after a full run of the good port: nothing is open, so the samples must find each bug.
    expect((await port()).code).toBe(0);
    for (const feature of bad) {
      const { code, summary } = await smoke('--candidate', badPath(feature));
      expect({ feature, code, clusters: summary.subset.smoke.clusters }).toEqual({ feature, code: 1, clusters: 0 });
      expect(summary.clusters.map((c) => describeSignature(c.signature))).toContain(BAD_PORTS[feature].signature);
    }

    // After a full run of the bad ports and minimizing their clusters, smoke runs each repro.
    const candidates = bad.flatMap((c) => ['--candidate', badPath(c)]);
    const run = JSON.parse((await port('--json', ...candidates)).stdout) as RunSummary & { run_id: string };
    const repros: string[] = [];
    for (const i of bad.keys()) repros.push((JSON.parse((await minimize('--json', `${run.run_id}/${i + 1}`)).stdout) as { case: { id: string } }).case.id);
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

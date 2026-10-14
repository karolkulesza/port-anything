import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlobStore, cacheDir, loadCommittedCases, readConfigFile } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The wc-lite example end to end: a C reference, its Rust port, and bad ports that are the same
// port built with one deliberate bug each (cargo features). Needs a C compiler and cargo; CI and
// the dev container have both (scripts/dev-linux.sh pnpm -r test).
const exec = promisify(execFile);
const example = fileURLToPath(new URL('../../../examples/wc-lite/', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** Each bad port's cargo feature and the fields its divergences show. */
const BAD_PORTS = {
  'bad-off-by-one': ['stdout'],
  'bad-crlf': ['stdout'],
  'bad-exit-code': ['exit'],
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
}

describe.runIf(enabled)('examples/wc-lite', () => {
  let project: string;
  const badPath = (feature: BadPort) => `./port/target/${feature}/release/wc-lite`;
  const port = (...args: string[]) =>
    exec(process.execPath, [binPath, 'run', ...(sandboxed ? [] : ['--no-sandbox']), ...args], { cwd: project }).then(
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

  it('prints a divergence for each bad port and none for a renamed identical copy (one run)', async () => {
    const bad = Object.keys(BAD_PORTS) as BadPort[];
    const args = ['./copy/wc-copy', ...bad.map(badPath)].flatMap((c) => ['--candidate', c]);
    const json = await port('--json', ...args);
    const { cases, candidates } = JSON.parse(json.stdout) as RunSummary;
    expect(json.code).toBe(1);
    expect(candidates[0]).toMatchObject({ command: './copy/wc-copy', match: cases, diverge: 0 });
    for (const [i, feature] of bad.entries()) {
      const { diverge, divergences } = candidates[i + 1]!;
      const fields = [...new Set(divergences.flatMap((d) => d.fields))];
      expect({ feature, diverging: diverge > 0, fields }).toEqual({ feature, diverging: true, fields: BAD_PORTS[feature] });
    }

    const text = await port(...args);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`candidate 1 ./copy/wc-copy: ${cases} of ${cases} cases match\n`);
    for (const [i, feature] of bad.entries()) {
      const { match, diverge } = candidates[i + 1]!;
      expect(text.stdout).toContain(`candidate ${i + 2} ${badPath(feature)}: ${match} of ${cases} cases match, ${diverge} diverge\n  cluster `);
    }
  }, 120_000);
});

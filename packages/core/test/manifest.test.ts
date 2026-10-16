import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baselineCases } from '../src/baseline.js';
import { BlobStore } from '../src/blob-store.js';
import { ConfigError } from '../src/config.js';
import type { Fingerprint } from '../src/fingerprint.js';
import {
  checkManifest,
  manifestCases,
  manifestGenerator,
  manifestNormalizers,
  manifestPath,
  readManifest,
  referenceObservationHashes,
  writeManifest,
  type Manifest,
} from '../src/manifest.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { NormalizersSchema } from '../src/normalize.js';
import { parseProgramCommand, resolveProgram, type ResolvedProgram } from '../src/program.js';

// Output that differs on every run in ways the proposed normalizers cover (temp paths, PIDs,
// timestamps, line order), plus one case no normalizer covers.
const NONDETERMINISTIC = `#!/bin/sh
counter="$PA_TEST_COUNTERS/$1"
n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$counter"
case "$1" in
  stable) echo same; echo note >&2 ;;
  log) echo "[2026-10-1\${n}T08:0\${n}:00Z] worker pid $$ started in $(pwd)" >&2; echo done ;;
  list) case $((n % 3)) in 0) printf 'apple\\nfig\\npear\\n' ;; 1) printf 'fig\\npear\\napple\\n' ;; *) printf 'pear\\napple\\nfig\\n' ;; esac ;;
  report) echo "generated 2026-10-14 10:00:0\${n}" > report.txt; echo ok ;;
  random) echo "token \${n}" ;;
esac
`;

const FINGERPRINT: Fingerprint = { mode: 'local', os: 'linux debian 12', arch: 'x64', libc: 'glibc 2.36', locale: 'C.UTF-8', reference: `sha256:${'a'.repeat(64)}` };

describe('observation hashes', () => {
  let root: string;
  let store: BlobStore;
  let reference: ResolvedProgram;
  let cases: CanonicalCase[];
  let scratch = 0;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-manifest-')));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'counters'));
    writeFileSync(join(root, 'bin', 'tool'), NONDETERMINISTIC, { mode: 0o755 });
    store = new BlobStore(join(root, 'cache'));
    reference = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool')));
    cases = ['stable', 'log', 'list', 'report', 'random'].map((name) => canonicalCase({ argv: [name], features: [`cmd.${name}`], origin: 'generated' }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const common = () => ({
    reference,
    cases,
    store,
    sandbox: { kind: 'none' } as const,
    workDir: join(root, `work-${scratch++}`),
    envAllowlist: ['PA_TEST_COUNTERS'],
    hostEnv: { ...process.env, PA_TEST_COUNTERS: join(root, 'counters') },
  });

  it('are the same on a later single run, in another directory, once the proposed normalizers apply', async () => {
    const baseline = await baselineCases(common());
    const pipeline = baseline.proposals.map((p) => p.spec);
    const frozen = new Map(baseline.cases.filter((c) => c.observationHash !== null).map((c) => [c.caseId, c.observationHash!]));
    expect(baseline.cases.map((c) => c.observationHash === null)).toEqual([false, false, false, false, true]);

    const later = await referenceObservationHashes({ ...common(), normalizers: pipeline });
    for (const [id, hash] of frozen) expect(later.get(id), id).toBe(hash);
    // Without the normalizers, output that varies between runs gives other hashes.
    const raw = await referenceObservationHashes(common());
    expect(raw.get(cases[0]!.id)).toBe(frozen.get(cases[0]!.id));
    expect(raw.get(cases[1]!.id)).not.toBe(frozen.get(cases[1]!.id));
  });
});

describe('manifest files', () => {
  let dir: string;
  const a = canonicalCase({ argv: ['a'], features: ['opt.a'], origin: 'recorded' });
  const b = canonicalCase({ argv: ['b'], origin: 'generated' });
  const hash = (c: string) => `sha256:${c.repeat(64)}`;
  const manifest = (): Manifest => ({
    version: 1,
    tool_version: '0.0.1',
    generator: manifestGenerator({ generator: 'v1', seed: 42, budget: 500, errorPathCap: 0.3, minCasesPerFeature: 20 }),
    normalizers: manifestNormalizers(NormalizersSchema.parse(['tmp-paths', { 'float-tolerance': { rtol: 1e-9 }, scope: 'stdout' }])),
    fingerprint: FINGERPRINT,
    cases: manifestCases([b, a], new Map([[a.id, hash('1')]])),
  });

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-manifest-file-')));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, with the cases sorted by ID, one per line', async () => {
    expect(await readManifest(dir)).toBeUndefined();
    await writeManifest(dir, manifest());
    expect(await readManifest(dir)).toEqual(manifest());
    const text = readFileSync(manifestPath(dir), 'utf8');
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(text).toContain(`\n    ${JSON.stringify({ id: first!.id, features: first!.features, observation: first === a ? hash('1') : null })},\n`);
    expect(text).toContain(`\n    ${JSON.stringify({ id: second!.id, features: second!.features, observation: second === a ? hash('1') : null })}\n  ]\n}\n`);
    expect(JSON.parse(text)).toEqual(manifest());
  });

  it('writes an empty case list as valid JSON', async () => {
    const empty = mkdtempSync(join(dir, 'empty-'));
    await writeManifest(empty, { ...manifest(), cases: [] });
    expect((await readManifest(empty))!.cases).toEqual([]);
  });

  it('refuses a manifest it does not understand', async () => {
    const bad = mkdtempSync(join(dir, 'bad-'));
    mkdirSync(join(bad, '.port-anything'));
    writeFileSync(manifestPath(bad), '{"version": 1');
    await expect(readManifest(bad)).rejects.toThrow(ConfigError);
    writeFileSync(manifestPath(bad), JSON.stringify({ ...manifest(), cases: [{ id: 'sha256:short', features: [], observation: null }] }));
    await expect(readManifest(bad)).rejects.toThrow(/cases\.0\.id/);
  });

  it('checks the generator, the normalizers, the cases, their features and their observations', () => {
    const frozen = manifest();
    const same = { generator: frozen.generator, normalizers: frozen.normalizers, cases: frozen.cases, fingerprint: FINGERPRINT };
    expect(checkManifest(frozen, same)).toEqual({ problems: [], fingerprint: [] });

    const c = canonicalCase({ argv: ['c'], origin: 'generated' });
    const [entryA, entryB] = [frozen.cases.find((e) => e.id === a.id)!, frozen.cases.find((e) => e.id === b.id)!];
    const changed = checkManifest(frozen, {
      generator: { ...frozen.generator!, budget: 100 },
      normalizers: [],
      cases: [{ ...entryA, features: [], observation: hash('2') }, { id: c.id, features: [], observation: hash('3') }],
      fingerprint: { ...FINGERPRINT, os: 'darwin 24.6.0' },
    });
    expect(changed.problems).toEqual([
      { kind: 'generator', frozen: frozen.generator, now: { ...frozen.generator, budget: 100 } },
      { kind: 'normalizers' },
      ...[
        [a.id, [{ kind: 'features', case: a.id, frozen: ['opt.a'], now: [] }, { kind: 'observation', case: a.id }]],
        [b.id, [{ kind: 'missing-case', case: b.id }]],
      ]
        .sort(([x], [y]) => (frozen.cases.findIndex((e) => e.id === x) - frozen.cases.findIndex((e) => e.id === y)))
        .flatMap(([, problems]) => problems as object[]),
      { kind: 'added-case', case: c.id },
    ]);
    expect(changed.fingerprint).toEqual(['os']);

    // A flaky-reference case has no frozen observation: whatever it gives now is fine.
    expect(checkManifest(frozen, { ...same, cases: [entryA, { ...entryB, observation: hash('4') }] }).problems).toEqual([]);
  });
});

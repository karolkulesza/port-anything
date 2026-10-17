import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDir, manifestPath, readManifest, shortCaseId, type Manifest, type SandboxProbe } from '@port-anything/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineCommand } from '../src/baseline-command.js';
import { run } from '../src/run.js';
import { TOOL_VERSION } from '../src/version.js';
import { parseVerifyArgs, verifyCommand } from '../src/verify-command.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
// Each case keeps a run counter under $PA_TEST_COUNTERS (allow-listed in the config): `log` prints
// a different time, PID and directory on every run (normalizers cover them), `random` a different
// token (flaky-reference).
const TOOL = (stable = 'same') => `#!/bin/sh
counter="$PA_TEST_COUNTERS/$1"
n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$counter"
case "$1" in
  stable) echo ${stable} ;;
  log) echo "[2026-10-14T08:00:$(printf %02d "$n")Z] worker pid $$ started in $(pwd)" >&2; echo done ;;
  random) echo "token \${n}" ;;
  exit) exit 3 ;;
esac
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

const CONFIG = `version: 1
reference: { cmd: ./bin/tool }
candidate: { cmd: ./bin/tool }
sandbox:
  env_allowlist: [PA_TEST_COUNTERS]
`;

const CASES = ['stable', 'log', 'random', 'exit'];

describe('parseVerifyArgs', () => {
  it('reads --no-sandbox and refuses anything else', () => {
    expect(parseVerifyArgs([])).toEqual({ noSandbox: false });
    expect(parseVerifyArgs(['--no-sandbox'])).toEqual({ noSandbox: true });
    expect(() => parseVerifyArgs(['--json'])).toThrow(/Usage: port-anything verify/);
  });
});

describe('verifyCommand', () => {
  let project: string;

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-verify-')));
    mkdirSync(join(project, 'bin'));
    mkdirSync(join(project, 'counters'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL(), { mode: 0o755 });
    process.env.PA_TEST_COUNTERS = join(project, 'counters');
    writeFileSync(join(project, 'port-anything.yaml'), CONFIG);
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    writeRecorded(CASES);
    const baseline = await baselineCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
    expect(baseline.stderr).toBe('');
    expect(baseline.exitCode).toBe(0);
  });
  afterEach(() => {
    delete process.env.PA_TEST_COUNTERS;
    rmSync(project, { recursive: true, force: true });
  });

  const writeRecorded = (names: string[]) =>
    writeFileSync(
      join(project, 'port-anything', 'recorded', 'cases.jsonl'),
      names.map((name) => `{"argv":["${name}"],"features":["cmd.${name}"],"origin":"recorded"}\n`).join(''),
    );
  const verify = () => verifyCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX });
  const manifest = async () => (await readManifest(project))!;
  const editManifest = async (edit: (m: Manifest) => void) => {
    const m = await manifest();
    edit(m);
    writeFileSync(manifestPath(project), JSON.stringify(m));
  };
  const caseOf = (m: Manifest, name: string) => m.cases.find((c) => c.features.includes(`cmd.${name}`))!;

  it('baseline freezes every case, the hash of each stable observation, the settings and the fingerprint', async () => {
    const m = await manifest();
    expect(m).toMatchObject({ version: 1, tool_version: TOOL_VERSION, generator: null, fingerprint: { mode: 'local', locale: 'C.UTF-8' } });
    expect(m.normalizers.map((n) => n.name)).toEqual(['tmp-paths', 'iso-timestamps', 'pids']);
    expect(m.cases).toHaveLength(4);
    expect(m.cases.map((c) => c.id)).toEqual(m.cases.map((c) => c.id).sort());
    expect(caseOf(m, 'random').observation).toBeNull();
    for (const name of ['stable', 'log', 'exit']) expect(caseOf(m, name).observation).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(manifestPath(project), 'utf8')).toMatch(/\n {4}\{"id":"sha256:[0-9a-f]{64}","features":\["cmd\.\w+"\],"observation":/);
  });

  it('passes on the corpus as frozen, though the reference prints other times, PIDs and directories', async () => {
    const result = await verify();
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('Checked 4 cases against .port-anything/MANIFEST.json, re-running the reference on 3, sandbox: none (--no-sandbox)\nmanifest intact\n');
    expect(result.exitCode).toBe(0);
  });

  it('exits 2, INTEGRITY BROKEN, when a frozen observation was edited', async () => {
    let edited = '';
    await editManifest((m) => {
      const c = caseOf(m, 'stable');
      edited = c.id;
      c.observation = `sha256:${'0'.repeat(64)}`;
    });
    const result = await run(['verify', '--no-sandbox'], { cwd: project });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('INTEGRITY BROKEN: 1 difference from the manifest\n');
    expect(result.stdout).toContain(`  ${shortCaseId(edited)}: the reference's observation no longer matches the frozen one\n`);
  });

  it('exits 2 when a committed case was edited or deleted, or a normalizer removed', async () => {
    const before = await manifest();
    writeRecorded(['stable', 'log', 'random', 'exit2']);
    const result = await verify();
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(`  ${shortCaseId(caseOf(before, 'exit').id)}: in the manifest, no longer in the corpus\n`);
    expect(result.stdout).toMatch(/: in the corpus, not in the manifest\n/);

    writeRecorded(CASES);
    writeFileSync(join(project, 'port-anything.yaml'), readFileSync(join(project, 'port-anything.yaml'), 'utf8').replace(/^ {2}- \{ pids: .*\n/m, ''));
    const loosened = await verify();
    expect(loosened.exitCode).toBe(2);
    expect(loosened.stdout).toContain('  normalizers: port-anything.yaml no longer has the 3 frozen with the corpus\n');
  });

  it('only warns when the environment fingerprint differs', async () => {
    await editManifest((m) => {
      m.fingerprint.os = 'linux some-other-distro 1';
      caseOf(m, 'stable').observation = `sha256:${'0'.repeat(64)}`;
    });
    const result = await verify();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('environment differs from the one the corpus was frozen in, so this check is not authoritative here:\n  os: linux some-other-distro 1 then, ');
    expect(result.stdout).not.toContain('INTEGRITY BROKEN');
    expect(result.stdout).toContain('1 difference from the manifest:\n');
    expect(result.stderr).toBe('port-anything verify: warning: 1 difference from the manifest, but the environment differs (os); re-baseline or use container mode.\n');
  });

  it('treats a changed reference executable as another environment', async () => {
    writeFileSync(join(project, 'bin', 'tool'), TOOL('changed'));
    const result = await verify();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\n {2}reference: sha256:[0-9a-f]{64} then, sha256:[0-9a-f]{64} now\n/);
    expect(result.stderr).toMatch(/warning: 1 difference from the manifest, but the environment differs \(reference\)/);
  });

  it('exits 3 without a manifest', async () => {
    rmSync(manifestPath(project));
    const result = await verify();
    expect(result).toEqual({ exitCode: 3, stdout: '', stderr: 'port-anything verify: No .port-anything/MANIFEST.json to verify: freeze the corpus with port-anything baseline first.\n' });
  });
});

// The frob tool of the generate tests, smaller: a generated corpus of a few dozen cases.
const FROB = `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -u, --upper     upper-case the output\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) ;;
    -u|--upper) upper=1 ;;
    --) shift; break ;;
    -?*) echo "frob: unrecognized option '$1'" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
cat "$@" | if [ -n "$upper" ]; then tr 'a-z' 'A-Z'; else cat; fi
`;

describe('verify on a generated corpus', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cli-verify-gen-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'frob'), FROB, { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('regenerates the cases in a fresh clone and finds them intact; a changed generator seed breaks it', { timeout: 120_000 }, async () => {
    const cli = (argv: string[]) => run(argv, { cwd: dir });
    expect((await cli(['compare', './bin/frob', './bin/frob', '--budget', '30', '--save', '--no-sandbox'])).exitCode).toBe(0);
    const baseline = await cli(['baseline', '--no-sandbox']);
    expect(baseline.exitCode).toBe(0);
    const m = (await readManifest(dir))!;
    expect(m.generator).toMatchObject({ version: 'v1', seed: 42, budget: 30 });
    expect(m.cases.length).toBeGreaterThan(5);

    rmSync(cacheDir(dir), { recursive: true }); // a fresh clone has no cache
    const verified = await cli(['verify', '--no-sandbox']);
    expect(verified.stderr).toBe('');
    expect(verified.stdout).toContain('manifest intact\n');
    expect(verified.exitCode).toBe(0);

    writeFileSync(join(dir, 'port-anything.yaml'), readFileSync(join(dir, 'port-anything.yaml'), 'utf8').replace(/generator_seed: 42/, 'generator_seed: 43'));
    const reseeded = await cli(['verify', '--no-sandbox']);
    expect(reseeded.exitCode).toBe(2);
    expect(reseeded.stdout).toContain('  generated corpus settings: v1, seed 42, budget 30, error path cap 0.3, min cases per feature 20 frozen, v1, seed 43, budget 30');
  });
});

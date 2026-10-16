import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { blobRef, caseId, latestRun, loadProbe, probesDir, reproPath, shortCaseId, type SandboxProbe } from '@port-anything/core';
import { formatCase, formatFeatures, formatNext, formatProbe, formatRun, formatStatus, type Backend, type NextReport } from '@port-anything/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../mcp/test/tokens.js';
import { baselineCommand } from '../src/baseline-command.js';
import { mcpCommand, projectBackend } from '../src/mcp-command.js';
import { runCommand } from '../src/run-command.js';

// Needs @port-anything/core and @port-anything/mcp built (`pnpm build`), like the other CLI tests.
const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

/** The reference; a port gets `upper`, `echo` or `fail` wrong as told. */
const TOOL = (wrong: { upper?: boolean; echo?: boolean; fail?: boolean } = {}) => `#!/bin/sh
case "$1" in
  echo) shift; echo ${wrong.echo ? '"[$*]"' : '"$@"'} ;;
  upper) ${wrong.upper ? 'cat' : "tr 'a-z' 'A-Z'"} ;;
  fail) echo "no" >&2; exit ${wrong.fail ? 2 : 1} ;;
esac
`;

/** A committed case's ID, as the corpus loads it. */
function caseIdOf(c: { argv: string[]; stdin?: string }): string {
  return caseId({ argv: c.argv, stdin: c.stdin === undefined ? null : blobRef(Buffer.from(c.stdin)), origin: 'recorded' });
}

describe('projectBackend', () => {
  let project: string;
  let backend: Backend;
  const port = (wrong: Parameters<typeof TOOL>[0]) => writeFileSync(join(project, 'bin', 'tool-port'), TOOL(wrong), { mode: 0o755 });
  const cases = [
    ...Array.from({ length: 6 }, (_, i) => ({ argv: ['upper'], stdin: `word ${i} and more words\n`, features: ['opt.u'] })),
    ...Array.from({ length: 4 }, (_, i) => ({ argv: ['echo', `e${i}`], features: ['opt.e'] })),
    { argv: ['fail'], features: ['error'] },
  ];

  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-mcp-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL(), { mode: 0o755 });
    port({ upper: true, fail: true });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-port }\ncorpus: { min_cases_per_feature: 1 }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), cases.map((c) => `${JSON.stringify({ ...c, origin: 'recorded' })}\n`).join(''));
    backend = projectBackend(project, { probe: NO_SANDBOX, noSandbox: true });
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('says there is no run yet', async () => {
    expect(await backend.status()).toMatchObject({ run: null, integrity: { manifest: null } });
    expect(await backend.next()).toEqual({ kind: 'no-run' });
  });

  it('status: headline numbers, the top clusters and the integrity state, under 500 tokens (done when)', async () => {
    expect((await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX })).exitCode).toBe(1);
    const status = await backend.status();
    expect(status).toMatchObject({
      run: { cases: 11, programName: 'tool', sandbox: 'none (--no-sandbox)' },
      candidates: [{ candidate: 1, command: './bin/tool-port', match: 4, diverge: 7, waived: 0 }],
      clusters: { total: 2, open: 2 },
      integrity: { manifest: null, flakyReference: 0, waivers: 0, largeWaivers: 0, normalizers: [] },
    });
    expect(status.clusters.top.map((k) => [k.cluster, k.size, k.description])).toEqual([
      [1, 6, 'stdout other'],
      [2, 1, 'exit 1 vs 2'],
    ]);
    const text = formatStatus(status);
    expect(text).toContain('c1 ./bin/tool-port: parity 33.3% over 3 features; 4 match, 7 diverge');
    expect(text).toContain('  #1 c1 · 6 cases · stdout other · opt.u (6)');
    expect(estimateTokens(text)).toBeLessThan(500);
  });

  it('next: the top cluster, minimized, with the diff; the repro is kept for the next call', async () => {
    const next = await backend.next();
    expect(next).toMatchObject({ kind: 'cluster', cluster: { cluster: 1, size: 6 }, open: 2, programName: 'tool', repro: { argv: ['upper'], minimized: true, exhausted: false } });
    const k = next as Extract<NextReport, { kind: 'cluster' }>;
    // Minimized down to one lowercase letter, which tr and cat treat differently.
    expect(k.repro.stdin).toMatch(/^[a-z]$/);
    expect(k.diff).toEqual([{ field: 'stdout', reference: (k.repro.stdin as string).toUpperCase(), candidate: k.repro.stdin }]);
    expect(formatNext(next)).toContain(`  $ tool upper\n  stdin: "${k.repro.stdin}"\ndiff (reference -, candidate +, after normalizers):\nstdout:\n  @@ line 1\n  - ${(k.repro.stdin as string).toUpperCase()}\n  + ${k.repro.stdin}\n`);
    // The smoke subset runs the saved repro for cluster 1; with nothing changed, nothing broke.
    expect(await backend.run({ smoke: true })).toMatchObject({ candidates: [{ fixed: 0, broke: 0 }] });
    const file = reproPath(project, k.cluster.run, 1);
    const saved = statSync(file).mtimeMs;
    expect(await backend.next()).toEqual(next);
    expect(statSync(file).mtimeMs).toBe(saved);
  });

  it('run: a fixed cluster shows as fixed, and next moves on to the next cluster', async () => {
    const full = (await latestRun(project))!.run_id;
    port({ fail: true });
    const delta = await backend.run({ cluster: '1' });
    expect(delta).toMatchObject({ selection: `cluster ${full}/1`, cases: 6, baseline: full, candidates: [{ match: 6, diverge: 0, fixed: 6, broke: 0, brokeCases: [] }], clusters: { total: 0 } });
    expect(formatRun(delta)).toContain('c1 ./bin/tool-port: 6 match, 0 diverge; fixed 6, broke 0');
    expect((await backend.status()).clusters).toMatchObject({ total: 2, open: 1, top: [{ cluster: 2 }] });
    expect(await backend.next()).toMatchObject({ kind: 'cluster', cluster: { cluster: 2, description: 'exit 1 vs 2' }, open: 1, diff: [{ field: 'exit', reference: '1', candidate: '2' }] });
    // A run of a subset doesn't replace the full run the deltas compare against.
    expect((await latestRun(project))!.run_id).toBe(full);
  });

  it('run: a feature, given cases or the smoke subset, with what broke', async () => {
    port({ fail: true, echo: true });
    const feature = await backend.run({ feature: 'opt.e' });
    expect(feature).toMatchObject({ selection: 'feature opt.e', cases: 4, candidates: [{ diverge: 4, fixed: 0, broke: 4 }] });
    expect(feature.candidates[0]!.brokeCases).toHaveLength(4);
    expect(formatRun(feature)).toMatch(/fixed 0, broke 4 \(c_[0-9a-f]{8} c_[0-9a-f]{8} c_[0-9a-f]{8} c_[0-9a-f]{8}\)/);
    port({});
    const fail = (await latestRun(project))!.clusters[1]!.cases[0]!;
    expect(await backend.run({ cases: [shortCaseId(fail)] })).toMatchObject({ selection: '1 given case', cases: 1, candidates: [{ diverge: 0, fixed: 1, broke: 0 }] });
    expect(await backend.run({ smoke: true })).toMatchObject({ selection: 'smoke subset of a 11-case corpus', candidates: [{ diverge: 0, broke: 0 }] });
    await expect(backend.run({ cluster: '9' })).rejects.toThrow(/has clusters 1 to 2, so there is no cluster 9/);
    await expect(backend.run({ feature: 'opt.zzz' })).rejects.toThrow(/No case has feature "opt.zzz"/);
  });

  it('status: the manifest once the corpus is frozen', async () => {
    expect((await baselineCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX })).exitCode).toBe(0);
    expect((await backend.status()).integrity.manifest).toEqual({ cases: 11, environment: 'same' });
    expect(formatStatus(await backend.status())).toContain('integrity: manifest frozen, 11 cases, same environment; port-anything verify checks it');
  });
});

describe('projectBackend: case, features and probe', () => {
  let project: string;
  let backend: Backend;
  const cases = [
    ...Array.from({ length: 3 }, (_, i) => ({ argv: ['upper'], stdin: `word ${i}\n`, features: ['opt.u'] })),
    ...Array.from({ length: 2 }, (_, i) => ({ argv: ['echo', `e${i}`], features: ['opt.e'] })),
    { argv: ['fail'], features: ['error'] },
  ];
  const SPEC = `version: 1
program: tool
flags:
  - { names: [-u, --upper], feature: opt.u, arity: 0 }
  - { names: [-e], feature: opt.e, arity: 1, values: [{ name: TEXT, type: string }] }
  - { names: [--help], feature: opt.help, arity: 0, self_description: true }
subcommands:
  - { name: write, feature: cmd.write }
`;

  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-mcp-tools-')));
    mkdirSync(join(project, 'bin'));
    // `write` creates a file, so a probe shows created files.
    const tool = (upper: string) => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${upper} ;;
  write) printf 'w\\n' > out.txt; cat "$2" ;;
  fail) echo "no" >&2; exit 1 ;;
esac
`;
    writeFileSync(join(project, 'bin', 'tool'), tool("tr 'a-z' 'A-Z'"), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-port'), tool('cat'), { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-port }\ncorpus: { min_cases_per_feature: 3 }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), cases.map((c) => `${JSON.stringify({ ...c, origin: 'recorded' })}\n`).join(''));
    backend = projectBackend(project, { probe: NO_SANDBOX, noSandbox: true });
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('features: nothing without a spec or a run', async () => {
    const f = await backend.features();
    expect(f).toEqual({ spec: null, run: null, candidates: [], prefix: null, features: [] });
    expect(formatFeatures(f)).toContain("no CLI spec (port-anything spec infer writes port-anything/cli-spec.yaml); features from the latest full run's cases only\nno saved run of the whole corpus yet");
  });

  it('case: one case in full before any run, on the configured candidate', async () => {
    // Not in the corpus (no stdin): its ID names nothing.
    await expect(backend.case(shortCaseId(caseIdOf({ argv: ['upper'] })))).rejects.toThrow(/c_[0-9a-f]{8}/);
    const r = await backend.case(shortCaseId(caseIdOf(cases[0]!)));
    expect(r).toMatchObject({
      origin: 'recorded',
      features: ['opt.u'],
      case: { argv: ['upper'], stdin: 'word 0\n', env: {}, fixtures: {} },
      cluster: null,
      programName: 'tool',
      candidate: { candidate: 1, command: './bin/tool-port' },
      reference: { exit: 0, signal: null, timeout: false, stdout: 'WORD 0\n', stderr: '', fs: '' },
      observed: { exit: 0, stdout: 'word 0\n' },
      diff: [{ field: 'stdout', reference: 'WORD 0\n', candidate: 'word 0\n' }],
    });
    expect(r.id).toBe(caseIdOf(cases[0]!));
    expect(formatCase(r)).toContain('reference:\n  exit 0\n  stdout: 1 line\n    | WORD 0\n');
    await expect(backend.case(shortCaseId(r.id), 2)).rejects.toThrow('There is no candidate 2: there is 1 candidate.');
  });

  it('case: in its cluster after a run, a match, and a repro of the latest run', async () => {
    expect((await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX })).exitCode).toBe(1);
    const run = (await latestRun(project))!;
    const upper = await backend.case(shortCaseId(caseIdOf(cases[1]!)));
    expect(upper.cluster).toMatchObject({ run: run.run_id, cluster: 1, size: 3, description: 'stdout other' });
    expect(formatCase(upper)).toContain(`in cluster ${run.run_id}/1: c1 · 3 cases · stdout other`);
    const echo = await backend.case(caseIdOf(cases[3]!).slice(0, 14));
    expect(echo).toMatchObject({ cluster: null, diff: [], reference: { stdout: 'e0\n' }, observed: { stdout: 'e0\n' } });
    expect(formatCase(echo)).toContain('match: the same after normalizers');
    // A run saves nothing for case: no new run.
    expect((await latestRun(project))!.run_id).toBe(run.run_id);
    const next = (await backend.next()) as Extract<NextReport, { kind: 'cluster' }>;
    const repro = JSON.parse(readFileSync(reproPath(project, run.run_id, 1), 'utf8')) as { case: { id: string } };
    expect(await backend.case(shortCaseId(repro.case.id))).toMatchObject({ case: { stdin: next.repro.stdin }, diff: [{ field: 'stdout' }] });
  });

  it('features: per-feature parity from the latest run, with the spec\'s features and marks', async () => {
    const plain = await backend.features();
    expect(plain.spec).toBeNull();
    expect(plain.features.map((f) => [f.feature, f.cases, f.parity, f.underSampled])).toEqual([
      ['error', 1, [1], true],
      ['opt.e', 2, [1], true],
      ['opt.u', 3, [0], false],
    ]);
    writeFileSync(join(project, 'port-anything', 'cli-spec.yaml'), SPEC);
    const f = await backend.features();
    const run = (await latestRun(project))!;
    expect(f).toMatchObject({ spec: { program: 'tool', features: 4 }, run: { id: run.run_id, minCasesPerFeature: 3 }, candidates: [{ candidate: 1, command: './bin/tool-port', parity: 0 }], prefix: null });
    expect(f.features.map((r) => [r.feature, r.spec, r.cases, r.parity[0], r.selfDescription])).toEqual([
      ['opt.u', '-u, --upper', 3, 0, false],
      ['opt.e', '-e TEXT', 2, 1, false],
      ['opt.help', '--help', 0, null, true],
      ['cmd.write', 'cmd write', 0, null, false],
      ['error', null, 1, 1, false],
    ]);
    const text = formatFeatures(f);
    expect(text).toContain('  opt.u · -u, --upper · 3 cases · 0.0%\n');
    expect(text).toContain('  opt.help · --help · 0 cases [untested, self-description]\n');
    expect(text).toContain('  error · 1 case · 100.0% [under-sampled, not in spec]\n');
    expect((await backend.features('opt.')).features.map((r) => r.feature)).toEqual(['opt.u', 'opt.e', 'opt.help']);
    writeFileSync(join(project, 'port-anything', 'cli-spec.yaml'), 'version: 1\n');
    await expect(backend.features()).rejects.toThrow(/cli-spec.yaml is not valid/);
    rmSync(join(project, 'port-anything', 'cli-spec.yaml'));
  });

  it('probe: runs the reference only, shows what it did and saves it under .port-anything/probes/', async () => {
    const runs = readdirSync(join(project, '.port-anything', 'runs')).length;
    const recorded = readFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), 'utf8');
    const p = await backend.probe({ argv: ['upper'], stdin: 'hi\n' });
    expect(p).toMatchObject({ programName: 'tool', case: { argv: ['upper'], stdin: 'hi\n', env: {}, fixtures: {} }, observed: { exit: 0, stdout: 'HI\n', stderr: '', fs: '' } });
    expect(p.path).toBe(`.port-anything/probes/${p.id}.json`);
    expect(formatProbe(p)).toContain('  $ tool upper\n  stdin: "hi\\n"\nreference:\n  exit 0\n  stdout: 1 line\n    | HI\n');
    expect(await loadProbe(project, p.id)).toMatchObject({ reference: './bin/tool', program_name: 'tool', case: { argv: ['upper'], stdin: 'hi\n' }, observation: { exit: 0, stdout: 'HI\n', stderr: '' } });

    const w = await backend.probe({ argv: ['write', 'in.txt'], fixtures: { 'in.txt': 'from a file\n' }, env: { X: '1' } });
    expect(w.observed).toMatchObject({ exit: 0, stdout: 'from a file\n', fs: expect.stringMatching(/^created out\.txt [0-9a-f]{12}\n$/) });
    expect((await loadProbe(project, w.id)).observation.fs.created).toEqual({ 'out.txt': 'w\n' });
    expect((await loadProbe(project, w.id)).case).toMatchObject({ env: { X: '1' }, fixtures: { 'in.txt': 'from a file\n' } });

    // Never part of the oracle: no run saved, no case added.
    expect(readdirSync(join(project, '.port-anything', 'runs')).length).toBe(runs);
    expect(readFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), 'utf8')).toBe(recorded);
    expect(readdirSync(probesDir(project))).toHaveLength(2);
    await expect(backend.probe({ argv: [], fixtures: { '../x': 'y' } })).rejects.toThrow(/Not an invocation that can run: fixtures/);
  });

  it('probe: refuses a destructive command line', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-mcp-git-')));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'git'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/git }\n');
      const git = projectBackend(dir, { probe: NO_SANDBOX, noSandbox: true });
      await expect(git.probe({ argv: ['clean', '-fdx'] })).rejects.toThrow('Refusing to probe "git clean"');
      expect(existsSync(probesDir(dir))).toBe(false);
      expect((await git.probe({ argv: ['status'] })).observed.stdout).toBe('status\n');
      // The name it runs as counts too: a multicall binary pinned as `rm` would run rm.
      writeFileSync(join(dir, 'bin', 'multi'), '#!/bin/sh\necho "$0 $@"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/multi }\nprogram_name: rm\n');
      await expect(git.probe({ argv: ['-rf', 'x'] })).rejects.toThrow('Refusing to probe "rm"');
      expect(readdirSync(probesDir(dir))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mcpCommand', () => {
  it('takes no arguments', async () => {
    expect(await mcpCommand(['--x'], { cwd: tmpdir() })).toMatchObject({ exitCode: 3, stderr: expect.stringContaining('Usage: port-anything mcp') });
  });

  it('serves over the given streams until the client closes them, writing nothing else', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-mcp-')));
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let out = '';
      stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      const served = mcpCommand([], { cwd: project, stdin, stdout });
      const send = (message: object) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
      await expect.poll(() => out.split('\n').filter(Boolean).length).toBe(2);
      stdin.end();
      expect(await served).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      const [init, status] = out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
      expect(init!.result.serverInfo).toMatchObject({ name: 'port-anything' });
      expect(status).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: expect.stringMatching(/^No saved run/) }] } });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { latestRun, reproPath, shortCaseId, type SandboxProbe } from '@port-anything/core';
import { formatNext, formatRun, formatStatus, type Backend, type NextReport } from '@port-anything/mcp';
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

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSandbox, type SandboxProbe } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../mcp/test/tokens.js';
import { runCommand } from '../src/run-command.js';

// The built server (`pnpm build` first) driven by the official MCP Inspector in CLI mode, as a
// client would: over stdio, with the inspector's own schema portability checks (--strict).
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const inspectorPath = fileURLToPath(new URL('../node_modules/.bin/inspector', import.meta.url));

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

const TOOL = (upper: string) => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${upper} ;;
esac
`;

interface Inspected {
  code: number;
  stdout: string;
  stderr: string;
}

// The inspector itself needs Node 22.19 or later; the server needs only what port-anything needs.
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const inspectorRuns = major > 22 || (major === 22 && minor >= 19);

describe.runIf(inspectorRuns)('port-anything mcp under the MCP Inspector (done when)', () => {
  let project: string;
  // `next` and `run` run programs, and the server has no --no-sandbox: they need a working sandbox here.
  let sandboxed = false;

  const inspect = (args: readonly string[]): Promise<Inspected> =>
    new Promise((resolve) => {
      execFile(
        inspectorPath,
        ['--cli', '--cwd', project, ...args, '--', process.execPath, binPath, 'mcp'],
        // The inspector keeps a catalog of servers; keep it out of the home directory.
        { env: { ...process.env, MCP_CATALOG_PATH: join(project, '.inspector-catalog.json') }, timeout: 120_000 },
        (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr }),
      );
    });
  // The tool result's text; after a result with isError, the inspector prints an error line too.
  const text = (r: Inspected) => (JSON.parse(r.stdout.split(/\n(?=\{"error")/)[0]!) as { content: { text: string }[] }).content[0]!.text;

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-inspector-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL("tr 'a-z' 'A-Z'"), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-port'), TOOL('cat'), { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-port }\ncorpus: { min_cases_per_feature: 1 }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    const cases = [
      ...Array.from({ length: 3 }, (_, i) => ({ argv: ['upper'], stdin: `word ${i}\n`, features: ['opt.u'], origin: 'recorded' })),
      ...Array.from({ length: 3 }, (_, i) => ({ argv: ['echo', `e${i}`], features: ['opt.e'], origin: 'recorded' })),
    ];
    writeFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), cases.map((c) => `${JSON.stringify(c)}\n`).join(''));
    expect((await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX })).exitCode).toBe(1);
    sandboxed = (await probeSandbox()).usable !== undefined;
  }, 60_000);
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('lists status, next and run, with schemas that pass the inspector\'s strict checks', async () => {
    const listed = await inspect(['--method', 'tools/list', '--strict']);
    expect(listed.code, listed.stderr).toBe(0);
    const { tools } = JSON.parse(listed.stdout) as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toEqual(['status', 'next', 'run']);
  }, 120_000);

  it('status answers with the headline, the clusters and the integrity state, in under 500 tokens', async () => {
    const status = await inspect(['--method', 'tools/call', '--tool-name', 'status']);
    expect(status.code, status.stderr).toBe(0);
    const answer = text(status);
    expect(answer).toContain('c1 ./bin/tool-port: parity 50.0% over 2 features; 3 match, 3 diverge');
    expect(answer).toContain('clusters: 1, 1 open; top 1:\n  #1 c1 · 3 cases · stdout other · opt.u (3)');
    expect(answer).toContain('integrity: manifest not frozen (port-anything baseline)');
    expect(estimateTokens(answer)).toBeLessThan(500);
  }, 120_000);

  it('run passes its arguments and reports errors as tool errors', async () => {
    const run = await inspect(['--method', 'tools/call', '--tool-name', 'run', '--tool-arg', 'cluster=9']);
    expect(run.code).not.toBe(0);
    expect(text(run)).toMatch(/has 1 cluster, so there is no cluster 9/);
  }, 120_000);

  it('next gives the repro and diff, and run of the cluster the deltas', async (context) => {
    if (!sandboxed) context.skip('no sandbox on this machine');
    const next = await inspect(['--method', 'tools/call', '--tool-name', 'next']);
    expect(next.code, next.stderr).toBe(0);
    expect(text(next)).toMatch(/repro \(minimized from c_[0-9a-f]{8}\):\n {2}\$ tool upper\n {2}stdin: "[a-z]"\ndiff/);
    writeFileSync(join(project, 'bin', 'tool-port'), TOOL("tr 'a-z' 'A-Z'"), { mode: 0o755 });
    const run = await inspect(['--method', 'tools/call', '--tool-name', 'run', '--tool-arg', 'cluster=1']);
    expect(run.code, run.stderr).toBe(0);
    expect(text(run)).toContain('3 match, 0 diverge; fixed 3, broke 0');
  }, 240_000);
});

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { SandboxProbe } from '@port-anything/core';
import { createServer, type Backend } from '@port-anything/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USAGE as BASELINE } from '../src/baseline-command.js';
import { USAGE as COMPARE } from '../src/compare-command.js';
import { USAGE as GENERATE } from '../src/generate-command.js';
import { USAGE as INIT } from '../src/init-command.js';
import { USAGE as MCP } from '../src/mcp-command.js';
import { USAGE as MINIMIZE } from '../src/minimize-command.js';
import { reportCommand, USAGE as REPORT } from '../src/report-command.js';
import { runCommand, USAGE as RUN } from '../src/run-command.js';
import { USAGE as SPEC } from '../src/spec-command.js';
import { USAGE as STRENGTH } from '../src/strength-command.js';
import { USAGE as VERIFY } from '../src/verify-command.js';
import { USAGE as WAIVE } from '../src/waive-command.js';

// The agent skills under skills/ tell an agent which commands, options, MCP tools and JSON fields
// to use; what they say must stay true as the CLI and the server change.
const NAMES = ['port-audit', 'port-loop', 'port-plan', 'port-report'] as const;
const skills = Object.fromEntries(NAMES.map((name) => [name, readFileSync(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url), 'utf8')])) as Record<(typeof NAMES)[number], string>;

/** Each subcommand's usage lines. */
const USAGES: Record<string, string> = { baseline: BASELINE, compare: COMPARE, generate: GENERATE, init: INIT, mcp: MCP, minimize: MINIMIZE, report: REPORT, run: RUN, spec: SPEC, strength: STRENGTH, verify: VERIFY, waive: WAIVE };

/** Every `port-anything …` invocation a skill shows, in its shell blocks and in inline code. */
function invocations(skill: string): string[] {
  const shell = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n')).map((line) => line.replace(/\s#.*$/, ''));
  const inline = [...skill.matchAll(/`((?:npx )?port-anything [^`]+)`/g)].map((m) => m[1]!);
  return [...shell, ...inline].flatMap((line) => [...line.matchAll(/(?:^|\s)(?:npx )?port-anything ([a-z][a-z-]*)([^;&|>]*)/g)]).map((m) => `${m[1]}${m[2]}`.trim());
}

/** The tools the MCP server lists, with their input properties, asked over MCP as a client would. */
async function listTools(): Promise<Map<string, string[]>> {
  const unused = () => Promise.reject(new Error('not called'));
  const backend: Backend = { status: unused, next: unused, run: unused };
  const [client, server] = InMemoryTransport.createLinkedPair();
  await createServer(backend, { version: '0.0.0' }).connect(server);
  const answers = new Map<number, (result: unknown) => void>();
  client.onmessage = (message) => {
    const m = message as { id?: number; result?: unknown };
    if (m.id !== undefined) answers.get(m.id)?.(m.result);
  };
  await client.start();
  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      answers.set(id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, params });
    });
  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'skills-test', version: '0.0.0' } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const { tools } = (await request(2, 'tools/list', {})) as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
  await client.close();
  return new Map(tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]));
}

describe.each(NAMES)('the %s skill', (name) => {
  const skill = skills[name];

  it('has the frontmatter a skill needs', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
    expect(front).toBeDefined();
    expect(front).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    const description = /^description: (.*)$/m.exec(front!)?.[1];
    expect(description).toMatch(/^\S.{40,}$/);
    // The limits agents put on a skill's description: 1024 characters, no XML-like tags.
    expect(description!.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
  });

  it('runs only subcommands and options this version has', () => {
    const lines = invocations(skill);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const [sub, ...rest] = line.split(/\s+/);
      expect(Object.keys(USAGES), line).toContain(sub);
      for (const option of rest.filter((w) => w.startsWith('--'))) expect(USAGES[sub!], line).toMatch(new RegExp(`${option.replace(/=.*/, '')}(?![a-z-])`));
    }
  });

  it('names only MCP tools and tool arguments the server has', async () => {
    const tools = await listTools();
    for (const m of skill.matchAll(/`([a-z_]+)` tools?\b/g)) expect([...tools.keys()], m[0]).toContain(m[1]);
    for (const m of skill.matchAll(/`([a-z_]+)` tool with `([a-z_]+)`/g)) expect(tools.get(m[1]!), m[0]).toContain(m[2]);
  });
});

describe('the port-loop skill', () => {
  const skill = skills['port-loop'];

  it('goes next, understand, edit, build, run the cluster, run smoke, commit, in that order', () => {
    const steps = [...skill.matchAll(/^\d\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]!);
    const loop = steps.slice(steps.indexOf('Take the next cluster:'));
    expect(loop).toEqual(['Take the next cluster:', "Understand the reference's behavior.", 'Edit the candidate', 'Build', 'Re-run the cluster:', 'Check for regressions:', 'Commit', 'Repeat']);
  });

  it('states the rules the oracle depends on', () => {
    const rules = skill.slice(skill.indexOf('## Rules'));
    expect(rules).toContain('**Never edit `.port-anything/`**');
    expect(rules).toContain('**Never call the reference from the candidate**');
    expect(rules).toMatch(/\*\*Any change to normalizers or waivers\*\*[^]*\*\*its own commit\*\*[^]*with the reason/);
  });
});

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

/** The values at a path such as `candidates[].features[].parity`; `[]` steps into every element. */
function valuesAt(value: unknown, path: string): unknown[] {
  let values = [value];
  for (const part of path.split('.')) {
    const key = part.replace(/\[\]$/, '');
    values = values.flatMap((v) => (v !== null && typeof v === 'object' && key in v ? [(v as Record<string, unknown>)[key]] : []));
    if (part.endsWith('[]')) values = values.flatMap((v) => (Array.isArray(v) ? v : []));
  }
  return values;
}

describe('the port-report skill describes fields the report and the history have', { timeout: 60_000 }, () => {
  const skill = skills['port-report'];
  let project: string;
  let report: unknown;
  let history: unknown;

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-report-skill-')));
    mkdirSync(join(project, 'bin'));
    // The port forgets to upper-case, so the run has a cluster.
    writeFileSync(join(project, 'bin', 'tool'), '#!/bin/sh\n[ "$1" = upper ] && exec tr a-z A-Z\necho "$@"\n', { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-port'), '#!/bin/sh\n[ "$1" = upper ] && exec cat\necho "$@"\n', { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-port }\ncorpus: { min_cases_per_feature: 1 }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    const cases = [
      ...Array.from({ length: 2 }, (_, i) => ({ argv: ['upper'], stdin: `word ${i}\n`, features: ['opt.u'], origin: 'recorded' })),
      ...Array.from({ length: 2 }, (_, i) => ({ argv: ['echo', `e${i}`], features: ['opt.e'], origin: 'recorded' })),
    ];
    writeFileSync(join(project, 'port-anything', 'recorded', 'cases.jsonl'), cases.map((c) => `${JSON.stringify(c)}\n`).join(''));
    expect((await runCommand(['--no-sandbox'], { cwd: project, probe: NO_SANDBOX })).exitCode).toBe(1);
    expect((await reportCommand(['--json'], { cwd: project })).exitCode).toBe(0);
    report = JSON.parse(readFileSync(join(project, 'port-anything-report.json'), 'utf8'));
    history = JSON.parse(readFileSync(join(project, '.port-anything', 'history.jsonl'), 'utf8').trimEnd().split('\n').at(-1)!);
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('in the field table, with the keys each row names', () => {
    const rows = skill.split('\n').filter((l) => /^\| `/.test(l));
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      const [paths, meaning] = [row.split('|')[1]!, row.split('|')[2]!];
      const named = [...paths.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      for (const path of named) expect(valuesAt(report, path), path).not.toEqual([]);
      // Keys a row lists after a colon (`scored`, `match`…) are keys of the row's (single) path.
      const keys = meaning.includes(':') ? [...meaning.slice(meaning.indexOf(':')).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((k) => k !== 'null') : [];
      for (const key of keys) expect(valuesAt(report, `${named[0]}.${key}`), `${named[0]}.${key}`).not.toEqual([]);
    }
  });

  it('in what it reads from the history', () => {
    const paragraph = skill.slice(skill.indexOf('`.port-anything/history.jsonl`'), skill.indexOf('For a cluster you want'));
    const keys = [...paragraph.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    expect(keys).toEqual(['parity', 'scored', 'match']);
    for (const key of keys) expect(valuesAt(history, `candidates[].${key}`), key).not.toEqual([]);
  });
});

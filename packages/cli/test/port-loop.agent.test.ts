import { execFile, spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findContainerEngine, probeSandbox } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portSource } from './wc-lite-source.js';

// The port-loop skill driven end to end by a real agent: Claude Code, headless, with the skill and
// the MCP server, on a copy of examples/wc-lite whose port has a few of the bad ports' bugs
// compiled into plain source (no cargo features, no "Bug:" notes). The agent must bring the port
// to full parity, committing its fixes, without touching the oracle.
//
// The project's setup (the planted port diverges, the clean one doesn't) is checked whenever the
// toolchain is there. The agent run costs model usage and takes minutes, so it runs only with
// PA_AGENT_E2E=1, and needs a logged-in `claude`. It runs once per sandbox mode: local needs cc,
// cargo and a sandbox (the MCP server always uses one); container needs Docker or Podman, and
// builds and runs everything in a Rust image. PA_AGENT_MODES picks the modes (default both, comma
// separated), PA_AGENT_MODEL the model (default sonnet); PA_AGENT_KEEP=1 keeps the projects and
// the transcripts.
const exec = promisify(execFile);
const example = fileURLToPath(new URL('../../../examples/wc-lite/', import.meta.url));
const skill = fileURLToPath(new URL('../../../skills/port-loop/SKILL.md', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** The bugs the agent has to find and fix: three clusters, in stdout and in the exit code. */
const PLANTED = ['bad-crlf', 'bad-exit-code', 'bad-no-total'];

const has = (cmd: string) => exec(cmd, ['--version']).then(() => true, () => false);
const toolchain = (await has('cc')) && (await has('cargo'));
const agent = process.env.PA_AGENT_E2E === '1';
const engine = agent ? await findContainerEngine().catch(() => undefined) : undefined;
const IMAGE = 'rust:1-slim';
type Mode = 'local' | 'container';
const modes = (process.env.PA_AGENT_MODES ?? 'local,container').split(',').map((m) => m.trim()) as Mode[];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
const sh = (cmd: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<Run> =>
  exec(cmd, [...args], { ...options, maxBuffer: 64 * 1024 * 1024 }).then(
    (r) => ({ ...r, code: 0 }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );

/**
 * A copy of the example as a fresh project: the port's source with `features` compiled in, its
 * Cargo.toml without the bad ports' features, no README or mutation score (they list the bugs).
 * In sandbox mode local both sides are built here; in container mode the config names the image,
 * and the first run builds both sides in it.
 */
async function plantedProject(features: readonly string[], mode: Mode = 'local'): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-port-loop-')));
  cpSync(example, dir, {
    recursive: true,
    filter: (src) => {
      const path = relative(example, src).split(sep).join('/');
      return !['README.md', 'mutation-score.json', 'ref/wc-lite', 'port/target', '.port-anything'].some((p) => path === p || path.startsWith(`${p}/`));
    },
  });
  const main = join(dir, 'port', 'src', 'main.rs');
  writeFileSync(main, portSource(readFileSync(main, 'utf8'), { features }));
  const cargo = join(dir, 'port', 'Cargo.toml');
  writeFileSync(cargo, readFileSync(cargo, 'utf8').replace(/\n# The port is correct[^]*?\n\[features\]\n(?:bad-[a-z-]+ = \[\]\n)+/, '\n'));
  if (mode === 'container') {
    const config = join(dir, 'port-anything.yaml');
    const text = readFileSync(config, 'utf8');
    if (!text.includes('\n  mode: local\n')) throw new Error('The example config no longer has sandbox mode local.');
    writeFileSync(config, text.replace('\n  mode: local\n', `\n  mode: container\n  image: ${IMAGE}\n`));
    return dir;
  }
  for (const cmd of ['cc -O2 -o ref/wc-lite ref/wc-lite.c', 'cargo build --release --manifest-path port/Cargo.toml']) {
    const built = await sh('sh', ['-c', cmd], { cwd: dir });
    if (built.code !== 0) throw new Error(`${cmd} failed:\n${built.stderr}`);
  }
  return dir;
}

interface RunJson {
  sandbox: string;
  candidates: { diverge: number }[];
  clusters: { candidate: number; signature: { fields: string[] } }[];
}
const runJson = async (dir: string, args: readonly string[] = []): Promise<RunJson & { code: number }> => {
  const r = await sh(process.execPath, [binPath, 'run', '--json', ...args], { cwd: dir });
  if (r.code === 3) throw new Error(r.stderr);
  return { ...(JSON.parse(r.stdout) as RunJson), code: r.code };
};

describe.runIf(toolchain)('the port-loop project on examples/wc-lite', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('matches the reference with nothing planted, and diverges in one cluster per planted bug', async () => {
    const [clean, planted] = await Promise.all([plantedProject([]), plantedProject(PLANTED)]);
    dirs.push(clean, planted);
    const source = readFileSync(join(planted, 'port', 'src', 'main.rs'), 'utf8');
    expect(source).not.toMatch(/bad-|Bug|cfg\(/);
    expect(readFileSync(join(planted, 'port', 'Cargo.toml'), 'utf8')).not.toMatch(/bad-|\[features\]/);
    const good = await runJson(clean, ['--no-sandbox']);
    expect(good.code).toBe(0);
    expect(good.candidates[0]!.diverge).toBe(0);
    const bad = await runJson(planted, ['--no-sandbox']);
    expect(bad.code).toBe(1);
    expect(bad.clusters.map((k) => k.signature.fields.join(',')).sort()).toEqual(['exit', 'stdout', 'stdout']);
  }, 300_000);
});

/** What the agent did, from Claude Code's stream-json transcript. */
interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}
function toolUses(transcript: string): ToolUse[] {
  return transcript
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      const event = JSON.parse(line) as { type?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
      return event.type === 'assistant' ? (event.message?.content ?? []) : [];
    })
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({ name: c.name!, input: c.input ?? {} }));
}

const PROMPT = `This directory is a Port Anything project: a small wc in C (ref/) and a Rust port of it (port/).
Use the port-loop skill to bring the port to full parity with the reference: every case must match.
Work on your own until no divergence cluster is open; nobody can answer questions during this session.
Commit your fixes as the skill says. Don't push.`;

for (const mode of modes)
describe.runIf(agent && (mode === 'container' || toolchain))(`Claude Code drives port-loop on examples/wc-lite (sandbox mode ${mode}, done when)`, () => {
  let project: string;
  let bin: string;
  let base: string;
  let transcript = '';
  let claude: Run;
  const keep = process.env.PA_AGENT_KEEP === '1';
  const git = (...args: string[]) => sh('git', args, { cwd: project }).then((r) => r.stdout.trim());

  beforeAll(async () => {
    if (mode === 'local' && (await probeSandbox()).usable === undefined) throw new Error('The MCP server runs cases in a sandbox, and there is none here.');
    if (mode === 'container' && engine === undefined) throw new Error('Sandbox mode container needs Docker or Podman running.');
    if (!(await has('claude'))) throw new Error('PA_AGENT_E2E needs Claude Code (claude) on the PATH, logged in.');
    project = await plantedProject(PLANTED, mode);
    // The project as a user's repo: the skill where Claude Code finds project skills, the
    // per-machine parts of .port-anything/ ignored, everything committed.
    mkdirSync(join(project, '.claude', 'skills', 'port-loop'), { recursive: true });
    cpSync(skill, join(project, '.claude', 'skills', 'port-loop', 'SKILL.md'));
    writeFileSync(join(project, '.gitignore'), `${readFileSync(join(project, '.gitignore'), 'utf8')}/.port-anything/cache/\n/.port-anything/runs/\n/.port-anything/tmp/\n`);
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'wc-lite and its port']]) await git(...args);
    base = await git('rev-parse', 'HEAD');

    // port-anything on the PATH (the skill's commands), and the MCP server it registers.
    bin = realpathSync(mkdtempSync(join(tmpdir(), 'pa-port-loop-bin-')));
    writeFileSync(join(bin, 'port-anything'), `#!/bin/sh\nexec "${process.execPath}" "${binPath}" "$@"\n`);
    chmodSync(join(bin, 'port-anything'), 0o755);
    const mcpConfig = join(bin, 'mcp.json');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'port-anything': { command: process.execPath, args: [binPath, 'mcp'] } } }));

    const args = [
      '-p',
      PROMPT,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      process.env.PA_AGENT_MODEL ?? 'sonnet',
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      // The project's settings only (none), so the user's own hooks and permissions stay out.
      '--setting-sources',
      'project',
      '--no-session-persistence',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ...['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'mcp__port-anything__status', 'mcp__port-anything__next', 'mcp__port-anything__run'],
    ];
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
    claude = await new Promise<Run>((resolve) => {
      const child = spawn('claude', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (transcript += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout: transcript, stderr }));
    });
    writeFileSync(join(bin, 'transcript.jsonl'), transcript);
    if (keep) console.log(`port-loop agent run (${mode}): project ${project}, transcript ${join(bin, 'transcript.jsonl')}`);
  }, 3_600_000);
  afterAll(() => {
    if (keep) return;
    for (const dir of [project, bin]) if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('finishes and uses the skill and the MCP tools: next, then run on a cluster and the smoke subset', () => {
    expect(claude.code, claude.stderr).toBe(0);
    const uses = toolUses(transcript);
    expect(uses.some((u) => u.name === 'Skill' && u.input.skill === 'port-loop'), 'the port-loop skill').toBe(true);
    expect(uses.some((u) => u.name === 'mcp__port-anything__next'), 'next').toBe(true);
    const runs = uses.filter((u) => u.name === 'mcp__port-anything__run');
    expect(runs.some((u) => u.input.cluster !== undefined), 'run of a cluster').toBe(true);
    expect(runs.some((u) => u.input.cluster === undefined && u.input.feature === undefined && u.input.cases === undefined), 'run of the smoke subset').toBe(true);
  });

  it('leaves a port that matches the reference on every case', async () => {
    const after = await runJson(project);
    expect(after.code).toBe(0);
    if (mode === 'container') expect(after.sandbox).toMatch(/container/);
    expect(after.candidates[0]!.diverge).toBe(0);
  }, 300_000);

  it('commits its fixes to the port only, and leaves the oracle as it was', async () => {
    const commits = (await git('rev-list', `${base}..HEAD`)).split('\n').filter(Boolean);
    expect(commits.length).toBeGreaterThan(0);
    const changed = (await git('diff', '--name-only', base, 'HEAD')).split('\n').filter(Boolean);
    for (const path of changed) expect(path, path).toMatch(/^port\/|^\.port-anything\/history\.jsonl$/);
    // Committed or not, nothing of the oracle changed: the reference, the cases, the config.
    expect(await git('status', '--porcelain', '--', 'ref', 'port-anything', 'port-anything.yaml', '.claude')).toBe('');
    expect(await git('diff', base, '--stat', '--', 'ref', 'port-anything', 'port-anything.yaml', '.claude')).toBe('');
    // The port computes its answers: nothing the agent added runs the reference or reads its source.
    const added = (await git('diff', base, '--', 'port')).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added.join('\n')).not.toMatch(/Command::new|process::Command|ref\/wc-lite/);
  });
});

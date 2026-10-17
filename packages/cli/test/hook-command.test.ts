import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSandbox } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_S } from '../src/hook-command.js';
import { run } from '../src/run.js';

// The hook runs the build and the smoke run in a worker process it can stop, so these tests run the built CLI.
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** Runs `port-anything hook` with `event` as Claude Code's JSON on stdin. */
function hook(event: unknown, args: string[] = [], cwd = tmpdir()): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [binPath, 'hook', ...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin!.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}

/** The text a hook's answer gives the agent, or undefined when it answered nothing. */
function context(stdout: string): string | undefined {
  if (stdout.trim() === '') return undefined;
  const answer = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(answer.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  return answer.hookSpecificOutput.additionalContext;
}

const edit = (project: string, file: string, tool = 'Edit') => ({
  session_id: 's',
  transcript_path: join(project, 't.jsonl'),
  cwd: project,
  hook_event_name: 'PostToolUse',
  tool_name: tool,
  tool_input: { file_path: file.startsWith('/') ? file : join(project, file), old_string: 'a', new_string: 'b' },
  tool_response: { success: true },
});

const tool = (body: string) => `#!/bin/sh\ncase "$1" in\n  echo) shift; echo "$@" ;;\n  upper) ${body} ;;\nesac\n`;

/**
 * A project whose reference lives in ref/ and whose candidate `port/tool` is made by its build from
 * port/src.sh. The candidate starts with a bug in `upper`.
 */
function makeProject(build = 'cp port/src.sh port/tool && chmod +x port/tool'): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-hook-')));
  mkdirSync(join(project, 'ref'));
  mkdirSync(join(project, 'port'));
  writeFileSync(join(project, 'ref', 'tool'), tool("tr 'a-z' 'A-Z'"));
  chmodSync(join(project, 'ref', 'tool'), 0o755);
  writeFileSync(join(project, 'port', 'src.sh'), tool('cat'));
  mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
  writeFileSync(
    join(project, 'port-anything', 'recorded', 'recorded.jsonl'),
    ['{"argv":["echo","hi"],"origin":"recorded"}', '{"argv":["upper"],"stdin":"hello\\n","origin":"recorded"}', ''].join('\n'),
  );
  writeFileSync(
    join(project, 'port-anything.yaml'),
    `version: 1\nprogram_name: tool\nreference: { cmd: ./ref/tool }\ncandidate:\n  cmd: ./port/tool\n  build: ${JSON.stringify(build)}\n`,
  );
  return project;
}

describe('port-anything hook (run `pnpm build` first)', () => {
  const projects: string[] = [];
  const project = (build?: string) => {
    const dir = makeProject(build);
    projects.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of projects) rmSync(dir, { recursive: true, force: true });
  });

  // The smoke run, like the MCP server's, runs programs in the sandbox: a test that gets that far needs one.
  let sandboxed = false;
  beforeAll(async () => {
    sandboxed = (await probeSandbox()).usable !== undefined;
  });

  it('is listed in --help', async () => {
    const help = await run(['--help']);
    expect(help.stdout).toContain('port-anything hook [--timeout <s>]');
  });

  it('after an edit to the candidate, builds it, runs the smoke subset and gives the agent the delta', async (ctx) => {
    if (!sandboxed) ctx.skip('no sandbox on this machine');
    const dir = project();
    // A first full run, for the delta: the candidate isn't built yet, so the hook's build is what makes it.
    writeFileSync(join(dir, 'port', 'tool'), tool('cat'));
    chmodSync(join(dir, 'port', 'tool'), 0o755);
    expect((await run(['run'], { cwd: dir })).exitCode).toBe(1);
    // The agent fixes the bug in the source; the hook rebuilds port/tool from it.
    writeFileSync(join(dir, 'port', 'src.sh'), tool("tr 'a-z' 'A-Z'"));
    const answer = await hook(edit(dir, 'port/src.sh'));
    expect(answer.code).toBe(0);
    const text = context(answer.stdout)!;
    expect(text).toContain('port-anything smoke after the edit to port/src.sh');
    expect(text).toMatch(/smoke subset of a 2-case corpus/);
    expect(text).toMatch(/c1 \.\/port\/tool: \d+ match, 0 diverge; fixed 1, broke 0/);
    expect(text).toContain('clusters: none');
  }, 60_000);

  it('a Write anywhere else in the project counts too, and a new bug shows as broke', async (ctx) => {
    if (!sandboxed) ctx.skip('no sandbox on this machine');
    const dir = project();
    writeFileSync(join(dir, 'port', 'tool'), tool("tr 'a-z' 'A-Z'"));
    chmodSync(join(dir, 'port', 'tool'), 0o755);
    expect((await run(['run'], { cwd: dir })).exitCode).toBe(0);
    writeFileSync(join(dir, 'port', 'src.sh'), tool('cat'));
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const text = context((await hook(edit(dir, 'notes.txt', 'Write'))).stdout)!;
    expect(text).toMatch(/1 diverge; fixed 0, broke 1 \(c_[0-9a-f]{8}\)/);
    expect(text).toMatch(/clusters: 1\n {2}#1/);
  }, 60_000);

  it('reports a failed build to the agent, and exits 0', { timeout: 60_000 }, async () => {
    const dir = project('echo "src.sh: syntax error near line 3" >&2; exit 7');
    const answer = await hook(edit(dir, 'port/src.sh'));
    expect(answer.code).toBe(0);
    const text = context(answer.stdout)!;
    expect(text).toContain('port-anything smoke after the edit to port/src.sh');
    expect(text).toContain('candidate.build failed (exit code 7)');
    expect(text).toContain('src.sh: syntax error near line 3');
    expect(existsSync(join(dir, '.port-anything', 'runs'))).toBe(false);
  });

  it('stops a build and smoke run that take longer than --timeout, and says so', async () => {
    const dir = project('sleep 30; touch built');
    const answer = await hook(edit(dir, 'port/src.sh'), ['--timeout', '1']);
    expect(answer.code).toBe(0);
    expect(context(answer.stdout)).toContain('smoke skipped: build/smoke took over 1 s');
    // Well under the 30 s build, with room for node's start-up on a busy machine.
    expect(answer.ms).toBeLessThan(20_000);
    // The build was stopped too, not left running.
    await new Promise((r) => setTimeout(r, 1500));
    expect(readdirSync(dir)).not.toContain('built');
  }, 40_000);

  it('does nothing for edits under port-anything/, .port-anything/ or the reference directory', async () => {
    const dir = project('touch built');
    for (const file of ['port-anything/recorded/recorded.jsonl', '.port-anything/history.jsonl', 'ref/tool']) {
      const answer = await hook(edit(dir, file));
      expect({ file, ...answer, ms: 0 }).toEqual({ file, code: 0, stdout: '', stderr: '', ms: 0 });
    }
    expect(readdirSync(dir)).not.toContain('built');
  }, 60_000);

  it('does nothing outside a port-anything project, for a file outside the project, or for an event without a file', async () => {
    const dir = project('touch built');
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pa-hook-elsewhere-')));
    projects.push(elsewhere);
    const events = [
      edit(elsewhere, 'main.rs'),
      edit(dir, join(elsewhere, 'main.rs')),
      { ...edit(dir, 'port/src.sh'), tool_input: { command: 'ls' }, tool_name: 'Bash' },
      'not json',
      '',
    ];
    for (const event of events) {
      const answer = await hook(event);
      expect({ event, ...answer, ms: 0 }).toEqual({ event, code: 0, stdout: '', stderr: '', ms: 0 });
    }
    expect(readdirSync(dir)).not.toContain('built');
  }, 60_000);

  it('a bad --timeout is reported to the agent, not a failed hook', async () => {
    const dir = project('touch built');
    for (const args of [['--timeout', '0'], ['--timeout', 'soon'], ['--verbose']]) {
      const answer = await hook(edit(dir, 'port/src.sh'), args);
      expect(answer.code).toBe(0);
      expect(context(answer.stdout)).toContain('Usage: port-anything hook [--timeout <s>]');
      expect(answer.stderr).toContain('Usage: port-anything hook [--timeout <s>]');
    }
    expect(readdirSync(dir)).not.toContain('built');
  }, 60_000);
});

describe.each(['../../../README.md', '../README.md'])('the smoke hook snippet in %s', (path) => {
  const readme = readFileSync(new URL(path, import.meta.url), 'utf8');

  it('is valid settings JSON that runs `port-anything hook` after Edit and Write, with room for its own time cap', () => {
    const snippet = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.includes('port-anything hook'));
    expect(snippet).toBeDefined();
    const settings = JSON.parse(snippet!) as { hooks: { PostToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] } };
    const [entry] = settings.hooks.PostToolUse;
    expect(entry!.matcher).toBe('Edit|Write');
    expect(entry!.hooks).toEqual([{ type: 'command', command: 'npx -y port-anything hook', timeout: expect.any(Number) }]);
    // Claude Code's own limit must leave the hook time to stop the run and answer.
    expect(entry!.hooks[0]!.timeout).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_S + 15);
  });
});

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { configCandidates, ConfigError, parseProgramCommand, readConfigFile } from '@port-anything/core';
import { formatRun } from '@port-anything/mcp';
import type { CliResult } from './common.js';
import { isInside, runBuild } from './git-ref.js';
import { projectBackend } from './mcp-command.js';

export const USAGE = 'Usage: port-anything hook [--timeout <s>]';

/** How long the build and the smoke run may take together, by default, before the hook stops them. */
export const DEFAULT_TIMEOUT_S = 60;

/** Time the worker gets to stop after SIGTERM before it, and whatever it started, gets SIGKILL. */
const STOP_GRACE_MS = 2000;

/** The part of Claude Code's hook event the hook reads. */
interface HookEvent {
  cwd?: unknown;
  tool_input?: { file_path?: unknown };
}

/**
 * `port-anything hook`: a Claude Code `PostToolUse` hook (matcher `Edit|Write`), turned on per
 * project in its `.claude/settings.json`. Reads the hook event from stdin. After an edit to a file
 * of the port-anything project in the event's working directory, outside `port-anything/`,
 * `.port-anything/` and the reference's directory, it builds the candidates (`candidate.build`, in
 * local mode; a container run builds them itself), runs the smoke subset as the MCP `run` tool does,
 * and gives the agent the result as additional context: what got fixed or broke, and the top
 * clusters. A failed build, a config error or a run past `--timeout` seconds (default 60) is
 * reported the same way. It always exits 0, so it never blocks or fails the agent's edit.
 */
export async function hookCommand(argv: readonly string[], options: { stdin?: Readable } = {}): Promise<CliResult> {
  const timeout = parseTimeout(argv);
  // Wrong arguments are a mistake in the settings: said to the agent (and on stderr) without waiting for an event.
  if (typeof timeout === 'string') return { ...answer(`port-anything hook: ${timeout}\n${USAGE}\n`), stderr: `port-anything hook: ${timeout}\n${USAGE}\n` };
  const scope = await editedFile(await readAll(options.stdin ?? process.stdin));
  if (scope === undefined) return { exitCode: 0, stdout: '', stderr: '' };
  const header = `port-anything smoke after the edit to ${scope.file}:\n`;
  return answer(header + (await smokeInWorker(scope.projectDir, timeout)));
}

/** The hook's answer: the text for the agent, in the JSON Claude Code reads from a hook's stdout. */
function answer(additionalContext: string): CliResult {
  return { exitCode: 0, stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } })}\n`, stderr: '' };
}

/** The `--timeout` in seconds, or what is wrong with the arguments. */
function parseTimeout(argv: readonly string[]): number | string {
  if (argv.length === 0) return DEFAULT_TIMEOUT_S;
  if (argv[0] !== '--timeout' || argv.length !== 2) return `unexpected argument "${argv[argv[0] === '--timeout' ? 2 : 0] ?? argv[0]}".`;
  const seconds = /^\d+(\.\d+)?$/.test(argv[1]!) ? Number(argv[1]) : NaN;
  return seconds > 0 ? seconds : `--timeout must be a positive number of seconds, not "${argv[1]}".`;
}

async function readAll(stream: Readable): Promise<string> {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk as string;
  return text;
}

/**
 * The project and the edited file (relative to it) when the edit should start a smoke run:
 * undefined for an event without a file, outside a port-anything project, for a file outside the
 * project, or for one under `port-anything/`, `.port-anything/` or the reference's directory.
 */
async function editedFile(input: string): Promise<{ projectDir: string; file: string } | undefined> {
  let event: HookEvent;
  try {
    event = JSON.parse(input) as HookEvent;
  } catch {
    return undefined;
  }
  if (event === null || typeof event !== 'object') return undefined;
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const path = event.tool_input?.file_path;
  if (typeof path !== 'string' || path === '' || !existsSync(join(cwd, 'port-anything.yaml'))) return undefined;
  // Links resolved on both sides, as far as the file exists (macOS's /var is /private/var).
  const projectDir = await realpath(cwd);
  const file = relative(projectDir, await realpathExisting(resolve(cwd, path)));
  if (!isInside(join(projectDir, file), projectDir) || file === '') return undefined;
  const top = file.split(sep)[0]!;
  if (top === 'port-anything' || top === '.port-anything') return undefined;
  const reference = await referencePath(projectDir);
  if (reference !== undefined && (file === reference || file.startsWith(`${reference.split(sep)[0]}${sep}`))) return undefined;
  return { projectDir, file };
}

/** `path` with links resolved in the part of it that exists. */
async function realpathExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realpathExisting(parent), relative(parent, path));
  }
}

/** The reference's program relative to the project, when it is a path inside it; its top directory is left out of the hook. */
async function referencePath(projectDir: string): Promise<string | undefined> {
  let program: string;
  try {
    program = parseProgramCommand((await readConfigFile(projectDir)).reference.cmd).executable;
  } catch {
    return undefined; // the worker reports the config error
  }
  if (!program.includes('/')) return undefined; // looked up on PATH
  const rel = relative(projectDir, await realpathExisting(isAbsolute(program) ? program : join(projectDir, program)));
  return rel === '' || !isInside(join(projectDir, rel), projectDir) ? undefined : rel;
}

/**
 * Runs `smokeText` in a worker process of its own process group, so that past `timeoutS` the
 * worker and everything it started (the build, the programs' runners) can be stopped together.
 */
function smokeInWorker(projectDir: string, timeoutS: number): Promise<string> {
  const worker = fileURLToPath(new URL('./hook-worker.js', import.meta.url));
  return new Promise((done) => {
    const child = spawn(process.execPath, [worker, projectDir], { cwd: projectDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s));
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // already gone
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      const kill = setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
      child.once('close', () => clearTimeout(kill));
    }, timeoutS * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done(`smoke not run: ${e.message}\n`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Anything the worker started and left behind goes with it.
      signalGroup('SIGKILL');
      if (timedOut) done(`smoke skipped: build/smoke took over ${timeoutS} s\n`);
      else if (code === 0) done(stdout);
      else done(`smoke not run: the worker ${signal === null ? `exited with code ${code}` : `was killed by ${signal}`}\n${stderr.trimEnd()}\n`);
    });
  });
}

/**
 * The text the hook gives the agent, run by the worker: the candidates built (local mode), then
 * the smoke subset run and its delta, as the MCP `run` tool gives it. A failed build or a config
 * error is the text instead.
 */
export async function smokeText(projectDir: string): Promise<string> {
  try {
    const config = await readConfigFile(projectDir);
    if (config.sandbox.mode !== 'container') {
      const candidates = configCandidates(config);
      for (const [i, c] of candidates.entries()) {
        if (c.build !== undefined) await runBuild(c.build, projectDir, config.candidates === undefined ? 'candidate.build' : `candidates.${i}.build`);
      }
    }
    return formatRun(await projectBackend(projectDir).run({ smoke: true }));
  } catch (e) {
    if (e instanceof ConfigError) return `${e.message}\n`;
    throw e;
  }
}

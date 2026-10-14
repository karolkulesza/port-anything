import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { BWRAP_STATUS_FD, caseCommandOptions, sandboxCommand, type SandboxSetup } from './sandbox.js';

/** How long a case may run before it is stopped (`sandbox.timeout`). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of each stream (stdout, stderr) is kept; a case that writes more is stopped. */
export const DEFAULT_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

/** Time between SIGTERM and SIGKILL when a case is stopped. */
export const DEFAULT_KILL_GRACE_MS = 1_000;

/**
 * Variables every case gets, whatever the host has: UTC, a UTF-8 locale that exists everywhere,
 * and a fixed build timestamp (2000-01-01T00:00:00Z) for tools that honour `SOURCE_DATE_EPOCH`.
 * `sandbox.env` in the config overrides them.
 */
export const DEFAULT_CASE_ENV: Readonly<Record<string, string>> = Object.freeze({
  TZ: 'UTC',
  LANG: 'C.UTF-8',
  SOURCE_DATE_EPOCH: '946684800',
});

/**
 * Host variables passed through to every case. PATH, so the program and anything it runs can be
 * found; both sides see the same one. Everything else needs `sandbox.env_allowlist`.
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = Object.freeze(['PATH']);

export interface CaseEnvironmentOptions {
  /** The case's HOME, inside its sandbox. */
  home: string;
  /** Extra host variables to pass through (`sandbox.env_allowlist`). */
  allowlist?: readonly string[];
  /** Overrides of the defaults (`sandbox.env`). */
  env?: Readonly<Record<string, string>>;
  /** The case's own variables. */
  caseEnv?: Readonly<Record<string, string>>;
  /** Defaults to this process's environment. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * The environment a case runs with. Built from scratch, never by removing from the host's, so
 * nothing outside the allow-list leaks in. Later layers win: allow-listed host variables, the
 * fixed defaults, `sandbox.env`, the case's own variables; HOME always points into the sandbox.
 */
export function caseEnvironment(options: CaseEnvironmentOptions): Record<string, string> {
  const host = options.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...(options.allowlist ?? [])]) {
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, DEFAULT_CASE_ENV, options.env, options.caseEnv);
  env.HOME = options.home;
  return env;
}

/** One process to run for a case. */
export interface ProcessSpec {
  /** The program and its arguments; argv[0] is looked up on the PATH. */
  argv: readonly string[];
  /** Working directory (absolute). */
  cwd: string;
  /** The complete environment, usually from `caseEnvironment`. */
  env: Readonly<Record<string, string>>;
  /** Bytes for stdin; null or absent means `/dev/null`. */
  stdin?: Uint8Array | null;
  sandbox: SandboxSetup;
  timeoutMs?: number;
  /** Per stream. */
  outputCapBytes?: number;
  killGraceMs?: number;
}

/** What one process did. `exit` is null exactly when a signal ended it. */
export interface ProcessResult {
  exit: number | null;
  signal: string | null;
  /** True when the runner stopped the case because it ran past its timeout. */
  timeout: boolean;
  stdout: Buffer;
  stderr: Buffer;
  /** True for a stream that went over the cap; it holds the first `outputCapBytes` bytes and the case was stopped. */
  truncated: { stdout: boolean; stderr: boolean };
  /** Wall-clock time from start to exit. CPU time is null: not measured yet. */
  time_ms: { wall: number; user: number | null; sys: number | null };
  /** Peak resident set size; null: not measured yet. */
  rss_kb: number | null;
}

/**
 * Runs one process in the given sandbox and captures what it did.
 *
 * - stdin, stdout and stderr are always pipes (or `/dev/null`), never a terminal.
 * - PWD is set to the working directory in every sandbox (bwrap sets it anyway).
 * - The process gets its own process group, so stopping it also stops whatever it started. bwrap
 *   puts the case in a session of its own; the runner learns its PID and signals that group too.
 *   Processes still running when the case exits are killed, so they can't hold the output open.
 * - Past the timeout, or when a stream goes over the cap, the groups get SIGTERM, then SIGKILL
 *   after the grace period.
 *
 * Under bwrap the case is a child of bwrap, which reports a signal death as exit code 128 + n.
 * Rejects only when the process can't be started at all (e.g. the program doesn't exist). Inside
 * a sandbox, a missing program is a case result instead: the sandbox tool starts, then reports the
 * failed exec on stderr with a non-zero exit, just as both sides would see it.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = spec.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const graceMs = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const bwrap = spec.sandbox.kind === 'bwrap';
  const { command, args, cwd } = sandboxCommand(spec.sandbox, spec.argv, spec.cwd, caseCommandOptions(spec.sandbox));
  const hasStdin = spec.stdin !== undefined && spec.stdin !== null;

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...spec.env, PWD: spec.cwd },
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(bwrap ? (['pipe'] as const) : [])],
      // A new session, hence a new process group the runner can signal as a whole.
      detached: true,
    });

    // Process groups to signal: the child's own, and under bwrap the sandboxed session.
    const groups: number[] = child.pid === undefined ? [] : [child.pid];
    let timedOut = false;
    let stopping = false;
    let exited = false;
    let wall = 0;
    let graceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const signalGroups = (signal: NodeJS.Signals) => {
      for (const group of groups) {
        try {
          process.kill(-group, signal);
        } catch {
          // The group is already gone.
        }
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signalGroups('SIGTERM');
      graceTimer = setTimeout(() => signalGroups('SIGKILL'), graceMs);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    if (bwrap) {
      const status = child.stdio[BWRAP_STATUS_FD] as NodeJS.ReadableStream;
      let text = '';
      status.setEncoding('utf8');
      status.on('data', (chunk: string) => {
        text += chunk;
        const match = /"child-pid":\s*(\d+)/.exec(text);
        if (match && groups.length < 2) {
          groups.push(Number(match[1]));
          if (stopping) signalGroups('SIGTERM');
        }
      });
      status.on('error', () => {});
    }

    const truncated = { stdout: false, stderr: false };
    const capture = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        if (truncated[name]) return;
        if (size + chunk.length > cap) {
          chunks.push(chunk.subarray(0, cap - size));
          size = cap;
          truncated[name] = true;
          clearTimeout(deadline); // stopped for its output, not its time
          stop();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      return () => Buffer.concat(chunks, size);
    };
    const stdout = capture(child.stdout!, 'stdout');
    const stderr = capture(child.stderr!, 'stderr');

    if (hasStdin) {
      // A case may exit without reading its input; the write then fails with EPIPE, which is fine.
      child.stdin!.on('error', () => {});
      child.stdin!.end(spec.stdin);
    }

    const clearTimers = () => {
      clearTimeout(deadline);
      clearTimeout(graceTimer);
      clearTimeout(drainTimer);
    };

    child.on('error', (error) => {
      clearTimers();
      reject(new Error(`Could not start ${command}: ${error.message}`, { cause: error }));
    });

    child.on('exit', () => {
      exited = true;
      wall = performance.now() - started;
      clearTimeout(deadline);
      signalGroups('SIGKILL'); // leftovers: background processes the case started
      // Something that left both groups (its own setsid) may still hold a pipe: stop waiting for it.
      drainTimer = setTimeout(() => {
        for (const stream of child.stdio) stream?.destroy();
      }, graceMs);
    });

    child.on('close', (code, signal) => {
      clearTimers();
      if (!exited) wall = performance.now() - started;
      resolve({
        exit: signal === null ? code : null,
        signal,
        timeout: timedOut,
        stdout: stdout(),
        stderr: stderr(),
        truncated,
        time_ms: { wall, user: null, sys: null },
        rss_kb: null,
      });
    });
  });
}

import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { DEFAULT_KILL_GRACE_MS, DEFAULT_OUTPUT_CAP_BYTES, DEFAULT_TIMEOUT_MS, type ProcessResult } from './process-runner.js';
import type { PinnedProgram } from './program.js';

/** The base image both sides run in when `sandbox.image` isn't set. */
export const DEFAULT_CONTAINER_IMAGE = 'debian:12-slim';

/** Container engines, in the order they are tried. Both take the same `run` options used here. */
export const CONTAINER_ENGINES: readonly string[] = Object.freeze(['docker', 'podman']);

/** Container mode: every case runs in a long-lived container of `image`, one per side per worker. */
export interface ContainerSetup {
  kind: 'container';
  /** The engine's command: `docker` or `podman`. */
  engine: string;
  image: string;
  /** CPUs the engine runs containers on, when known: Docker Desktop's VM may have fewer than the host. */
  cpus?: number;
}

/** Thrown when container mode can't start: no engine, an image that can't be pulled, a build that fails. */
export class ContainerError extends Error {
  override readonly name = 'ContainerError';
}

/** Where a session's runner files are mounted in its container. */
const IO_DIR = '/pa-io';

/**
 * The runner each long-lived container runs (with `sh`, since the image may have nothing else).
 * The host prepares each case in a new directory `<IO_DIR>/<n>`: the case directory's path (`dir`),
 * its files (`case/`), the script to run (`cmd`) and maybe `stdin`. Only new names cross the mount
 * from the host: Docker Desktop's file sharing may show a container the old content of a path the
 * host rewrote. For each `run <n> <timeout s> <grace s>` line, the runner copies the files to the
 * case directory, on the tmpfs, runs the script in a session of its own with stdout and stderr in
 * files, and a watchdog that sends SIGTERM to the case's process group at the timeout, then SIGKILL
 * after the grace period. Once the case has exited and whatever it left running has been killed,
 * it copies the case directory back (`result/`) and answers `done <status> <1 if timed out>`. As
 * under bwrap, a signal death is the shell's exit status 128 + n.
 */
export const RUNNER_SCRIPT = [
  'echo ready',
  'while read -r cmd n t g; do',
  '  [ "$cmd" = run ] || exit 0',
  `  i=${IO_DIR}/$n`,
  '  IFS= read -r c <"$i/dir"',
  '  rm -rf "$c" && cp -a "$i/case" "$c"',
  '  setsid sh "$i/cmd" >"$i/out" 2>"$i/err" &',
  '  pid=$!',
  `  setsid sh -c 'sleep "$1"; : >"$4"; kill -15 "-$3"; sleep "$2"; kill -9 "-$3"' watchdog "$t" "$g" "$pid" "$i/timedout" >/dev/null 2>&1 &`,
  '  wd=$!',
  '  wait "$pid"',
  '  status=$?',
  '  kill -9 "-$wd" "-$pid" 2>/dev/null',
  '  wait "$wd" 2>/dev/null',
  '  if [ -e "$i/timedout" ]; then to=1; else to=0; fi',
  '  cp -a "$c" "$i/result" 2>/dev/null',
  '  rm -rf "$c"',
  '  echo "done $status $to"',
  'done',
].join('\n');

/** Quotes a word for `sh`: single quotes, each `'` written as `'\''`. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** One process to run in a session; the paths are as the container sees them. */
export interface ContainerProcess {
  argv: readonly string[];
  /** Working directory: the case directory given to `ContainerPool.session`. */
  cwd: string;
  /** The complete environment. */
  env: Readonly<Record<string, string>>;
  /** Bytes for stdin; null or absent means `/dev/null`. */
  stdin?: Uint8Array | null;
}

/**
 * The script a session runs for one case: in its directory, files limited to just over the output
 * cap (`ulimit -f`, in 512-byte blocks: a case writing more is stopped by SIGXFSZ, as the local
 * runner stops it), an environment built from nothing, stdin from `stdinPath` or `/dev/null`.
 */
export function caseScript(proc: ContainerProcess, outputCapBytes: number, stdinPath: string): string {
  if (proc.argv.length === 0) throw new Error('Cannot run an empty argv.');
  const blocks = Math.ceil((outputCapBytes + 1) / 512);
  const env = Object.entries({ ...proc.env, PWD: proc.cwd }).map(([k, v]) => shellQuote(`${k}=${v}`));
  const stdin = proc.stdin === undefined || proc.stdin === null ? '/dev/null' : shellQuote(stdinPath);
  return [
    `cd ${shellQuote(proc.cwd)} || exit 126`,
    `ulimit -f ${blocks}`,
    `exec env -i ${env.join(' ')} ${proc.argv.map(shellQuote).join(' ')} <${stdin}`,
    '',
  ].join('\n');
}

export interface CommandResult {
  ok: boolean;
  /** stdout and stderr, as written. */
  output: string;
}

/** Runs an engine command to completion. */
export function engineCommand(engine: string, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(engine, args, { timeout: options.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${stdout}${stderr}`.trim() || (error?.message ?? '') });
    });
  });
}

/**
 * The first engine of `CONTAINER_ENGINES` whose daemon answers, or a `ContainerError` that says
 * what each one replied.
 */
export async function findContainerEngine(engines: readonly string[] = CONTAINER_ENGINES): Promise<string> {
  const failures: string[] = [];
  for (const engine of engines) {
    const info = await engineCommand(engine, ['info'], { timeoutMs: 30_000 });
    if (info.ok) return engine;
    failures.push(`  ${engine}: ${info.output.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'no answer'}`);
  }
  throw new ContainerError(
    ['Sandbox mode "container" needs Docker or Podman running, and neither answers:', ...failures, 'Start one of them, or set sandbox.mode to local.'].join('\n'),
  );
}

/**
 * How many CPUs the engine's containers get (`info`): the host's on Linux, the VM's with Docker
 * Desktop or a Podman machine. Undefined when the engine doesn't say.
 */
export async function engineCpus(engine: string): Promise<number | undefined> {
  const format = basename(engine) === 'podman' ? '{{.Host.CPUs}}' : '{{.NCPU}}';
  const info = await engineCommand(engine, ['info', '--format', format], { timeoutMs: 30_000 });
  const cpus = Number(info.output);
  return info.ok && Number.isInteger(cpus) && cpus > 0 ? cpus : undefined;
}

/** Pulls `image` unless the engine has it already. */
export async function ensureImage(engine: string, image: string): Promise<void> {
  if ((await engineCommand(engine, ['image', 'inspect', image])).ok) return;
  const pulled = await engineCommand(engine, ['pull', image]);
  if (!pulled.ok) throw new ContainerError(`Cannot pull the image ${image} (sandbox.image):\n${pulled.output}`);
}

/** The PATH `image` sets, for the cases that run in it; the usual one when it sets none. */
export async function imagePath(engine: string, image: string): Promise<string> {
  const inspected = await engineCommand(engine, ['image', 'inspect', '--format', '{{json .Config.Env}}', image]);
  if (inspected.ok) {
    try {
      const env = JSON.parse(inspected.output) as string[] | null;
      const path = env?.find((e) => e.startsWith('PATH='));
      if (path !== undefined) return path.slice('PATH='.length);
    } catch {
      // not JSON: use the default
    }
  }
  return '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
}

/**
 * Runs as the caller, so files written into mounted directories belong to them (Docker on Linux
 * would make them root's). Rootless Podman maps the caller's IDs into the container instead.
 */
function userArgs(engine: string): string[] {
  if (basename(engine) === 'podman') return ['--userns=keep-id'];
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];
  return ['--user', `${process.getuid()}:${process.getgid()}`];
}

/**
 * Runs a build command (`reference.build`, `candidate.build`) in `image`, in `dir` mounted at the
 * same path, so the programs the config names are built for the image: on macOS a binary built on
 * the host wouldn't run in a Linux container. The network is on, as builds may fetch dependencies.
 */
export async function buildInImage(setup: ContainerSetup, dir: string, command: string): Promise<CommandResult> {
  const abs = resolve(dir);
  return engineCommand(setup.engine, [
    'run', '--rm', '--init', ...userArgs(setup.engine),
    '-v', `${abs}:${abs}`, '-w', abs, '-e', 'HOME=/tmp',
    '--entrypoint', '/bin/sh', setup.image, '-c', command,
  ]);
}

export interface ContainerPoolOptions {
  setup: ContainerSetup;
  /** Scratch directory for the sessions' files; created if needed. */
  dir: string;
  timeoutMs?: number;
  killGraceMs?: number;
  /** Per stream. */
  outputCapBytes?: number;
}

/**
 * The long-lived containers of a run: one per side per case directory parent (one per worker slot),
 * started on first use. Each container sees only its own side's program, and has a tmpfs where the
 * case directory goes, so both sides run at the same path but the candidate never sees the
 * reference's files. The root filesystem is read-only, `/tmp` is a tmpfs, there is no network. Each container has the label `port-anything=<the pool's directory>`.
 */
export class ContainerPool {
  private readonly sessions = new Map<string, Promise<ContainerSession>>();
  private readonly started: ContainerSession[] = [];
  private path: Promise<string> | undefined;
  private closed = false;
  private readonly cleanup = () => {
    for (const session of this.started) session.forceRemove();
  };

  constructor(private readonly options: ContainerPoolOptions) {
    process.once('exit', this.cleanup);
  }

  /** The PATH of the image, which cases get instead of the host's. */
  imagePath(): Promise<string> {
    this.path ??= imagePath(this.options.setup.engine, this.options.setup.image);
    return this.path;
  }

  /** The session for one side and one case directory (whose parent is what it mounts). */
  session(side: PinnedProgram, caseDir: string): Promise<ContainerSession> {
    if (this.closed) return Promise.reject(new Error('The container pool is closed.'));
    const parent = dirname(caseDir);
    const key = `${side.binDir}\0${parent}`;
    let session = this.sessions.get(key);
    if (session === undefined) {
      const dir = join(resolve(this.options.dir), `session-${this.sessions.size}`);
      session = ContainerSession.start({ ...this.options, dir, label: resolve(this.options.dir), side, parent }).then((s) => {
        this.started.push(s);
        return s;
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  /** Stops every container. */
  async close(): Promise<void> {
    this.closed = true;
    process.removeListener('exit', this.cleanup);
    const sessions = await Promise.allSettled(this.sessions.values());
    await Promise.all(sessions.map((s) => (s.status === 'fulfilled' ? s.value.close() : undefined)));
  }
}

interface SessionOptions extends ContainerPoolOptions {
  dir: string;
  /** The value of the container's `port-anything` label: the pool's directory. */
  label: string;
  side: PinnedProgram;
  /** The case directory's parent, as the container sees it: a tmpfs. */
  parent: string;
}

type Limits = { timeoutMs?: number; killGraceMs?: number; outputCapBytes?: number };

/** One case in a session: its files go in `files`, then it runs once. */
export interface ContainerCase {
  /** Host directory whose content becomes the case directory. */
  files: string;
  /** Runs the case. `result` is a host directory holding the case directory as the case left it. */
  run(proc: ContainerProcess, limits?: Limits): Promise<ProcessResult & { result: string }>;
  /** Removes the case's files from the host. */
  dispose(): Promise<void>;
}

/** One long-lived container and the runner in it; runs one case at a time. */
export class ContainerSession {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lines: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private ended = false;
  private stderr = '';
  private cases = 0;

  private constructor(
    private readonly options: SessionOptions,
    private readonly name: string,
    private readonly child: ChildProcessWithoutNullStreams,
    /** Host directory mounted at the runner's IO directory. */
    private readonly io: string,
  ) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else this.lines.push(line);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      this.ended = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
    });
    child.on('error', (error) => {
      this.stderr += error.message;
    });
  }

  static async start(options: SessionOptions): Promise<ContainerSession> {
    const io = join(options.dir, 'io');
    await mkdir(io, { recursive: true });
    const name = `port-anything-${randomBytes(6).toString('hex')}`;
    const { engine, image } = options.setup;
    const child = spawn(engine, [
      'run', '--rm', '-i', '--init', '--name', name, '--label', `port-anything=${options.label}`,
      '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', `${options.parent}:exec,mode=1777`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...userArgs(engine),
      '-v', `${io}:${IO_DIR}`,
      ...options.side.readOnlyPaths.flatMap((p) => ['-v', `${p}:${p}:ro`]),
      '-w', IO_DIR, '--entrypoint', '/bin/sh', image, '-c', RUNNER_SCRIPT,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new ContainerSession(options, name, child, io);
    const ready = await session.nextLine(120_000);
    if (ready !== 'ready') {
      session.forceRemove();
      throw new ContainerError(`The container for ${options.side.binDir} did not start (${image}):\n${session.stderr.trim() || ready || 'no output'}`);
    }
    return session;
  }

  /** A new case to run in `caseDir`, a directory in the session's parent directory. */
  async prepare(caseDir: string): Promise<ContainerCase> {
    if (dirname(caseDir) !== this.options.parent) throw new Error(`${caseDir} is not in ${this.options.parent}.`);
    const n = this.cases++;
    const dir = join(this.io, String(n));
    const files = join(dir, 'case');
    await mkdir(files, { recursive: true });
    await writeFile(join(dir, 'dir'), `${caseDir}\n`);
    return {
      files,
      run: (proc, limits = {}) => {
        const result = this.queue.then(() => this.runNow(n, proc, limits));
        this.queue = result.catch(() => {});
        return result;
      },
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  }

  private async runNow(n: number, proc: ContainerProcess, limits: Limits): Promise<ProcessResult & { result: string }> {
    const timeoutMs = limits.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = limits.killGraceMs ?? this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const cap = limits.outputCapBytes ?? this.options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
    const dir = join(this.io, String(n));
    await writeFile(join(dir, 'cmd'), caseScript(proc, cap, `${IO_DIR}/${n}/stdin`));
    if (proc.stdin !== undefined && proc.stdin !== null) await writeFile(join(dir, 'stdin'), proc.stdin);
    const started = performance.now();
    this.child.stdin.write(`run ${n} ${(timeoutMs / 1000).toFixed(3)} ${(graceMs / 1000).toFixed(3)}\n`);
    // The watchdog in the container stops the case; this only guards against a stuck container.
    const line = await this.nextLine(timeoutMs + graceMs + 60_000);
    const wall = performance.now() - started;
    const match = line === undefined ? null : /^done (\d+) ([01])$/.exec(line);
    if (match === null) {
      this.forceRemove();
      throw new ContainerError(`The container ${this.name} stopped answering (${this.options.setup.image}):\n${this.stderr.trim() || line || 'no output'}`);
    }
    const read = async (file: string) => {
      const data = await readFile(join(dir, file)).catch(() => Buffer.alloc(0));
      return { data: data.length > cap ? data.subarray(0, cap) : data, truncated: data.length > cap };
    };
    const [stdout, stderr] = await Promise.all([read('out'), read('err')]);
    return {
      exit: Number(match[1]),
      signal: null,
      timeout: match[2] === '1',
      stdout: stdout.data,
      stderr: stderr.data,
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
      time_ms: { wall, user: null, sys: null },
      rss_kb: null,
      result: join(dir, 'result'),
    };
  }

  private nextLine(timeoutMs: number): Promise<string | undefined> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.waiting = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  /** Ends the runner (its container is removed as it exits), or removes the container after 10 s. */
  async close(): Promise<void> {
    if (!this.ended) {
      this.child.stdin.end();
      const exited = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
      const timer = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 10_000).unref());
      if ((await Promise.race([exited, timer])) === 'late') this.forceRemove();
    }
    await rm(this.options.dir, { recursive: true, force: true });
  }

  /** Removes the container now, synchronously (also on process exit). */
  forceRemove(): void {
    if (this.ended) return;
    spawnSync(this.options.setup.engine, ['rm', '-f', this.name], { stdio: 'ignore', timeout: 30_000 });
    this.child.kill('SIGKILL');
  }
}

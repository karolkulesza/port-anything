import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_KILL_GRACE_MS, DEFAULT_OUTPUT_CAP_BYTES, DEFAULT_TIMEOUT_MS, type ProcessResult } from './process-runner.js';
import type { PinnedProgram } from './program.js';
import { packTar, treeEntries, unpackTar } from './tar.js';

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

/** Where the runner keeps a case's script, stdin and output in its container (on the `/tmp` tmpfs). */
const RUNNER_DIR = '/tmp/pa-runner';

/** What the runner uses from the image, beside `sh` and its built-ins. */
export const RUNNER_TOOLS: readonly string[] = Object.freeze(['tar', 'dd', 'wc', 'cat', 'mkdir', 'rm', 'mv', 'chmod', 'setsid', 'sleep']);

/**
 * The runner each long-lived container runs (with `sh`, since the image may have nothing else), fed
 * over its stdin and answering on its stdout; no host directory is shared with it. It first checks
 * that the image has `RUNNER_TOOLS` (or answers `missing <tools>` and stops), then says `ready`.
 * For each case the host sends a line `run <nonce> <timeout s> <grace s> <bytes>`, then that many bytes: a
 * tar archive holding `dir` (the case directory's path), `cmd` (the script to run), maybe `stdin`,
 * and `case/` (the case's files). The runner reads exactly those bytes (`dd`, one read at a time:
 * `head -c` from BusyBox reads ahead), unpacks them, moves `case/` to the case directory (on the
 * tmpfs), and runs the script in a session of its own with stdout and stderr in files and a watchdog
 * that sends SIGTERM to the case's process group at the timeout, then SIGKILL after the grace period.
 * Once the case has exited, it kills every process in the container but itself (anything the case
 * left behind, even in a session of its own), archives the case directory and answers `done <nonce>
 * <status> <1 if timed out> <stdout bytes> <stderr bytes> <archive bytes>`, followed by stdout,
 * stderr and the archive. As under bwrap, a signal death is the shell's exit status 128 + n. When it
 * can't unpack a case or archive its directory, it answers `error <nonce> <in|back> <bytes>` and
 * that many bytes of what went wrong. Everything the runner sends comes from a container that ran a
 * case, so the host checks it all and writes nothing outside a directory of its own (`unpackTar`).
 * A case could write to the runner's stdout too, but not with the nonce: the runner read that line
 * before the case started.
 */
export const RUNNER_SCRIPT = [
  `m=; for t in ${RUNNER_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 || m="$m $t"; done`,
  'if [ -n "$m" ]; then echo "missing$m"; exit 0; fi',
  'echo ready',
  // take <bytes> <file>: exactly that many bytes of stdin; fails at the end of the input.
  'take() {',
  '  : >"$2"; got=0',
  '  while [ "$got" -lt "$1" ]; do',
  '    b=$(($1 - got)); [ "$b" -le 65536 ] || b=65536',
  '    dd bs="$b" count=1 2>/dev/null >>"$2"',
  '    now=$(wc -c <"$2")',
  '    [ "$now" -gt "$got" ] || return 1',
  '    got=$now',
  '  done',
  '}',
  // fail <in|back>: what went wrong, from the error file.
  'fail() { echo "error $nonce $1 $(wc -c <"$p/error")"; cat "$p/error"; }',
  `p=${RUNNER_DIR}`,
  'while read -r cmd nonce t g bytes; do',
  '  [ "$cmd" = run ] || exit 0',
  '  rm -rf "$p" && mkdir "$p" && take "$bytes" "$p/in.tar" || exit 1',
  '  if ! { tar -xf "$p/in.tar" -C "$p" && c=$(cat "$p/dir") && rm -rf "$c" && mv "$p/case" "$c"; } 2>"$p/error"; then fail in; continue; fi',
  '  setsid sh "$p/cmd" </dev/null >"$p/out" 2>"$p/err" &',
  '  pid=$!',
  `  setsid sh -c 'sleep "$1"; : >"$4"; kill -15 "-$3"; sleep "$2"; kill -9 "-$3"' watchdog "$t" "$g" "$pid" "$p/timedout" >/dev/null 2>&1 &`,
  '  wd=$!',
  '  wait "$pid"',
  '  status=$?',
  // The watchdog by its PID too: a case can end before the watchdog has made its process group.
  '  kill -9 "$wd" "-$wd" "-$pid" 2>/dev/null',
  '  wait "$wd" 2>/dev/null',
  // Every process but this one (and the init process): kill -1 never signals the caller.
  '  kill -9 -1 2>/dev/null',
  '  if [ -e "$p/timedout" ]; then to=1; else to=0; fi',
  // Files the case made unreadable are still the case's files (local mode reads them too).
  '  chmod -R u+rwX "$c" 2>/dev/null',
  '  if ! tar -cf "$p/back.tar" -C "$c" . 2>"$p/error"; then rm -rf "$c"; fail back; continue; fi',
  '  rm -rf "$c"',
  '  echo "done $nonce $status $to $(wc -c <"$p/out") $(wc -c <"$p/err") $(wc -c <"$p/back.tar")"',
  '  cat "$p/out" "$p/err" "$p/back.tar"',
  'done',
].join('\n');

/**
 * Reads a container's stdout: lines (the runner's answers) and the exact byte counts that follow
 * them.
 */
class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  private wake: (() => void) | undefined;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.size += chunk.length;
      this.wake?.();
    });
    stream.on('end', () => this.end());
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  private flat(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private take(n: number): Buffer {
    const all = this.flat();
    const taken = Buffer.from(all.subarray(0, n));
    this.chunks = n < all.length ? [all.subarray(n)] : [];
    this.size -= n;
    return taken;
  }

  /** Waits until `ready` holds, the stream ends or `ms` pass; whether `ready` holds. */
  private async until(ready: () => boolean, ms: number): Promise<boolean> {
    const deadline = performance.now() + ms;
    while (!ready()) {
      const left = deadline - performance.now();
      if (this.ended || left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    return true;
  }

  /** The next line, without its newline; undefined if none comes within `ms` (or over 4 KiB of no newline). */
  async line(ms: number): Promise<string | undefined> {
    let at = -1;
    const found = await this.until(() => {
      if (this.size === 0) return false;
      at = this.flat().indexOf(0x0a);
      return at !== -1 || this.size > 4096;
    }, ms);
    if (!found || at === -1) return undefined;
    return this.take(at + 1).subarray(0, at).toString('utf8');
  }

  /** The next `n` bytes; undefined if they don't all come within `ms`. */
  async bytes(n: number, ms: number): Promise<Buffer | undefined> {
    return (await this.until(() => this.size >= n, ms)) ? this.take(n) : undefined;
  }
}

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
  private readonly reader: FrameReader;
  private ended = false;
  private stderr = '';
  private cases = 0;

  private constructor(
    private readonly options: SessionOptions,
    private readonly name: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    this.reader = new FrameReader(child.stdout);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      this.ended = true;
      this.reader.end();
    });
    child.on('error', (error) => {
      this.stderr += error.message;
      this.reader.end();
    });
  }

  static async start(options: SessionOptions): Promise<ContainerSession> {
    await mkdir(options.dir, { recursive: true });
    const name = `port-anything-${randomBytes(6).toString('hex')}`;
    const { engine, image } = options.setup;
    const child = spawn(engine, [
      'run', '--rm', '-i', '--init', '--name', name, '--label', `port-anything=${options.label}`,
      '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', `${options.parent}:exec,mode=1777`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...userArgs(engine),
      ...options.side.readOnlyPaths.flatMap((p) => ['-v', `${p}:${p}:ro`]),
      '-w', '/tmp', '--entrypoint', '/bin/sh', image, '-c', RUNNER_SCRIPT,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new ContainerSession(options, name, child);
    const ready = await session.reader.line(120_000);
    if (ready !== 'ready') {
      session.forceRemove();
      if (ready?.startsWith('missing ')) {
        throw new ContainerError(`The image ${image} (sandbox.image) has no ${ready.slice('missing '.length).split(' ').join(', ')}: container mode runs cases with them. Use an image that has them, such as ${DEFAULT_CONTAINER_IMAGE}.`);
      }
      throw new ContainerError(`The container for ${options.side.binDir} did not start (${image}):\n${session.stderr.trim() || ready || 'no output'}`);
    }
    return session;
  }

  /** A new case to run in `caseDir`, a directory in the session's parent directory. */
  async prepare(caseDir: string): Promise<ContainerCase> {
    if (dirname(caseDir) !== this.options.parent) throw new Error(`${caseDir} is not in ${this.options.parent}.`);
    const dir = join(this.options.dir, String(this.cases++));
    const files = join(dir, 'case');
    await mkdir(files, { recursive: true });
    return {
      files,
      run: (proc, limits = {}) => {
        const result = this.queue.then(() => this.runNow(caseDir, dir, proc, limits));
        this.queue = result.catch(() => {});
        return result;
      },
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  }

  private async runNow(caseDir: string, dir: string, proc: ContainerProcess, limits: Limits): Promise<ProcessResult & { result: string }> {
    const timeoutMs = limits.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = limits.killGraceMs ?? this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const cap = limits.outputCapBytes ?? this.options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
    if (this.ended) throw new ContainerError(`The container ${this.name} has stopped (${this.options.setup.image}):\n${this.stderr.trim() || 'no output'}`);
    const stdin = proc.stdin === undefined || proc.stdin === null ? [] : [{ type: 'file' as const, name: Buffer.from('stdin'), data: Buffer.from(proc.stdin) }];
    const input = packTar([
      { type: 'file', name: Buffer.from('dir'), data: Buffer.from(caseDir) },
      { type: 'file', name: Buffer.from('cmd'), data: Buffer.from(caseScript(proc, cap, `${RUNNER_DIR}/stdin`)) },
      ...stdin,
      ...(await treeEntries(join(dir, 'case'), 'case')),
    ]);
    const nonce = randomBytes(8).toString('hex');
    const started = performance.now();
    this.child.stdin.write(`run ${nonce} ${(timeoutMs / 1000).toFixed(3)} ${(graceMs / 1000).toFixed(3)} ${input.length}\n`);
    this.child.stdin.write(input);
    // The watchdog in the container stops the case; this only guards against a stuck container.
    const line = await this.reader.line(timeoutMs + graceMs + 60_000);
    const wall = performance.now() - started;
    // A case may have written to the runner's stdout: an answer without the nonce ends the session.
    const broken = (what: string): never => {
      this.forceRemove();
      throw new ContainerError(`The container ${this.name} ${what} (${this.options.setup.image}):\n${this.stderr.trim() || line || 'no output'}`);
    };
    const failed = line?.startsWith(`error ${nonce} `) ? /^error \S+ (in|back) (\d+)$/.exec(line) : null;
    if (failed !== null) {
      const message = await this.reader.bytes(Number(failed[2]), 60_000);
      if (message === undefined) return broken('stopped answering');
      const what = failed[1] === 'in' ? 'could not copy in the files of a case' : 'could not copy back the directory of a case';
      throw new ContainerError(`The container ${this.name} ${what} (${this.options.setup.image}):\n${message.toString('utf8').trim() || 'no message'}`);
    }
    const match = line?.startsWith(`done ${nonce} `) ? /^done \S+ (\d+) ([01]) (\d+) (\d+) (\d+)$/.exec(line) : null;
    if (match === null) return broken('stopped answering');
    const [outBytes, errBytes, tarBytes] = match.slice(3).map(Number) as [number, number, number];
    const payload = await this.reader.bytes(outBytes + errBytes + tarBytes, 60_000 + (outBytes + errBytes + tarBytes) / 1000);
    if (payload === undefined) return broken('stopped in the middle of an answer');
    const result = join(dir, 'result');
    try {
      await unpackTar(payload.subarray(outBytes + errBytes), result);
    } catch (e) {
      return broken(`sent back a case directory that can't be unpacked: ${(e as Error).message}`);
    }
    const capped = (data: Buffer) => ({ data: data.length > cap ? data.subarray(0, cap) : data, truncated: data.length > cap });
    const stdout = capped(payload.subarray(0, outBytes));
    const stderr = capped(payload.subarray(outBytes, outBytes + errBytes));
    return {
      exit: Number(match[1]),
      signal: null,
      timeout: match[2] === '1',
      stdout: stdout.data,
      stderr: stderr.data,
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
      time_ms: { wall, user: null, sys: null },
      rss_kb: null,
      result,
    };
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
    // Before the engine's client has even exited: no case may start in it any more.
    this.ended = true;
    this.reader.end();
  }
}

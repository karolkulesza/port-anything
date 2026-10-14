import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * How a case runs locally:
 * - `bwrap`: bubblewrap. Read-only view of the system, writable case workdir, private `/tmp` and
 *   `/run`, no network, and (where the kernel allows it) its own PID namespace.
 * - `unshare`: fallback when bwrap isn't usable. No network, but the filesystem is not isolated.
 * - `none`: no isolation at all; only with `--no-sandbox`.
 *
 * Neither is a strong security boundary: they keep a trusted program from touching the network or
 * (with bwrap) files outside its workdir by accident. A Unix socket the user keeps somewhere in
 * their own files (not under /tmp or /run) stays reachable.
 */
export type SandboxKind = 'bwrap' | 'unshare' | 'none';

/** A sandbox that isolates something; what the probe looks for. */
export type LocalSandbox = Exclude<SandboxKind, 'none'>;

/** A sandbox and the variant of it that works on this machine. */
export type SandboxSetup =
  /** isolatePids: false where a fresh /proc can't be mounted, e.g. inside Docker's default profile. */
  | { kind: 'bwrap'; isolatePids: boolean }
  /** mapCurrentUser: false on util-linux before 2.38; `id` then shows the overflow uid, file access is unchanged. */
  | { kind: 'unshare'; mapCurrentUser: boolean }
  | { kind: 'none' };

/** The process to spawn for one case. */
export interface SandboxCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface SandboxCommandOptions {
  /**
   * bwrap only: a file descriptor the spawned bwrap inherits, on which it writes JSON lines, the
   * first being `{"child-pid": <pid>}` (the sandboxed process, as seen from outside). The case
   * itself doesn't get the descriptor.
   */
  statusFd?: number;
}

/** The descriptor bwrap reports its status on when the runner starts a case. */
export const BWRAP_STATUS_FD = 3;

/**
 * The options the runner uses for every case in this sandbox, so the start-up probe tries exactly
 * what cases will get: a bwrap too old for `--json-status-fd` must fail the probe, not every case.
 */
export function caseCommandOptions(setup: SandboxSetup): SandboxCommandOptions {
  return setup.kind === 'bwrap' ? { statusFd: BWRAP_STATUS_FD } : {};
}

/** Wraps `argv` so it runs in `workdir` (an absolute path) inside the given sandbox. */
export function sandboxCommand(
  setup: SandboxSetup,
  argv: readonly string[],
  workdir: string,
  options: SandboxCommandOptions = {},
): SandboxCommand {
  if (argv.length === 0) throw new Error('Cannot run an empty argv.');
  if (!isAbsolute(workdir)) throw new Error(`The case workdir must be an absolute path, got "${workdir}".`);
  switch (setup.kind) {
    case 'bwrap':
      return {
        command: 'bwrap',
        args: [
          ...['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'],
          // Read-only doesn't stop connect() on a socket file: hide the service sockets (D-Bus,
          // docker.sock, ...) under /run, and under /var/run where it isn't a symlink to /run.
          ...['--tmpfs', '/run', ...(varRunIsDirectory() ? ['--tmpfs', '/var/run'] : [])],
          // Order matters: later mounts go on top, so the workdir bind must follow the tmpfs mounts.
          ...['--bind', workdir, workdir, '--chdir', workdir],
          ...['--unshare-user', '--unshare-ipc', '--unshare-uts', '--unshare-net'],
          // Without a PID namespace a case could signal any of the user's processes (kill -9 -1).
          ...(setup.isolatePids ? ['--unshare-pid'] : []),
          ...['--die-with-parent', '--new-session'],
          ...(options.statusFd === undefined ? [] : ['--json-status-fd', String(options.statusFd)]),
          '--',
          ...argv,
        ],
        cwd: workdir,
      };
    case 'unshare':
      // --map-current-user rather than -r: as uid 0, programs would skip permission checks.
      return {
        command: 'unshare',
        args: ['--user', ...(setup.mapCurrentUser ? ['--map-current-user'] : []), '--net', '--', ...argv],
        cwd: workdir,
      };
    case 'none':
      return { command: argv[0]!, args: argv.slice(1), cwd: workdir };
  }
}

let varRunDir: boolean | undefined;
function varRunIsDirectory(): boolean {
  if (varRunDir === undefined) {
    try {
      varRunDir = lstatSync('/var/run').isDirectory();
    } catch {
      varRunDir = false;
    }
  }
  return varRunDir;
}

/** What the probe needs from the machine; tests pass a fake. */
export interface SandboxHost {
  platform: NodeJS.Platform;
  /** An existing directory the probe can use as a workdir. */
  tempDir: string;
  /** True inside Docker or Podman, where the default seccomp profile blocks user namespaces. */
  inContainer: boolean;
  /** Runs a command to completion. `missing` means the command isn't installed. */
  run(command: string, args: readonly string[], cwd: string): Promise<{ ok: true } | { ok: false; message: string; missing?: boolean }>;
  /** Reads a file such as a sysctl under /proc/sys, trimmed; undefined when it doesn't exist. */
  readSetting(path: string): Promise<string | undefined>;
}

export interface SandboxAttempt {
  kind: LocalSandbox;
  ok: boolean;
  /** Why it failed: the tool's own message (from its most basic variant). */
  error?: string;
}

export interface SandboxProbe {
  /** The best sandbox setup that works here, if any. */
  usable: Exclude<SandboxSetup, { kind: 'none' }> | undefined;
  attempts: SandboxAttempt[];
  /** When nothing works: what to do about it, ready to print. */
  fix: string | undefined;
}

// Per platform, each sandbox's variants from strongest to most basic.
const PROBE_ORDER: Record<string, Exclude<SandboxSetup, { kind: 'none' }>[][]> = {
  linux: [
    [
      { kind: 'bwrap', isolatePids: true },
      { kind: 'bwrap', isolatePids: false },
    ],
    [
      { kind: 'unshare', mapCurrentUser: true },
      { kind: 'unshare', mapCurrentUser: false },
    ],
  ],
};

/**
 * Finds out which local sandbox works by running `true` in each variant, with exactly the
 * arguments real cases get. Run once at start-up: Ubuntu 24.04+ (AppArmor), Docker's default
 * seccomp profile and some kernels' sysctls all block the unprivileged user namespaces both tools need.
 */
export async function probeSandbox(host: SandboxHost = localHost()): Promise<SandboxProbe> {
  const attempts: SandboxAttempt[] = [];
  const missing = new Set<LocalSandbox>();
  const workdir = resolve(host.tempDir);
  for (const variants of PROBE_ORDER[host.platform] ?? []) {
    const kind = variants[0]!.kind;
    let error = '';
    for (const setup of variants) {
      const { command, args, cwd } = sandboxCommand(setup, ['true'], workdir, caseCommandOptions(setup));
      const result = await host.run(command, args, cwd);
      if (result.ok) {
        attempts.push({ kind, ok: true });
        return { usable: setup, attempts, fix: undefined };
      }
      error = result.message;
      if (result.missing) {
        missing.add(kind);
        break;
      }
    }
    attempts.push({ kind, ok: false, error });
  }
  return { usable: undefined, attempts, fix: await fixText(host, missing) };
}

const SYSCTL = {
  apparmor: '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  debianClone: '/proc/sys/kernel/unprivileged_userns_clone',
  maxUserNs: '/proc/sys/user/max_user_namespaces',
};

async function fixText(host: SandboxHost, missing: Set<LocalSandbox>): Promise<string> {
  const steps: string[] = [];
  if (host.platform === 'linux') {
    if (missing.has('bwrap')) {
      steps.push('Install bubblewrap: sudo apt install bubblewrap (Debian/Ubuntu) or sudo dnf install bubblewrap (Fedora).');
    }
    if (missing.has('unshare')) {
      steps.push('Install util-linux, which provides unshare.');
    }
    if (host.inContainer) {
      steps.push(
        "Inside Docker or Podman, the default seccomp profile blocks user namespaces: start the container with --security-opt seccomp=unconfined (and --security-opt apparmor=unconfined on AppArmor hosts).",
      );
    }
    if ((await host.readSetting(SYSCTL.apparmor)) === '1') {
      steps.push(
        [
          'Ubuntu 24.04+ restricts user namespaces through AppArmor. Let bubblewrap use them with the profile Ubuntu ships:',
          '    sudo apt install apparmor-profiles',
          '    sudo install -m 644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/',
          '    sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict',
        ].join('\n'),
        'On a throwaway CI runner only, lift the restriction for everything instead:\n    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      );
    }
    if ((await host.readSetting(SYSCTL.debianClone)) === '0') {
      steps.push('Unprivileged user namespaces are turned off: sudo sysctl -w kernel.unprivileged_userns_clone=1');
    }
    if ((await host.readSetting(SYSCTL.maxUserNs)) === '0') {
      steps.push('User namespaces are limited to 0: sudo sysctl -w user.max_user_namespaces=15000');
    }
    if (steps.length === 0) {
      steps.push('Make sure unprivileged user namespaces are allowed (bwrap and unshare -n both need them).');
    }
  } else {
    steps.push(`There is no local sandbox for ${host.platform} yet. Use sandbox mode "container" instead.`);
  }
  steps.push(
    'For trusted programs only: pass --no-sandbox. Cases then run with full access to the network and your files.',
  );
  return steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n');
}

/** The sandbox a run uses; `label` is what the report's "sandbox used" field shows. */
export type SandboxChoice = SandboxSetup & { label: string };

function label(setup: SandboxSetup): string {
  switch (setup.kind) {
    case 'bwrap':
      return setup.isolatePids ? 'bwrap, no network' : 'bwrap, no network (processes not isolated)';
    case 'unshare':
      return 'unshare, no network (filesystem not isolated)';
    case 'none':
      return 'none (--no-sandbox)';
  }
}

/** Thrown when no sandbox works and `--no-sandbox` wasn't given. The message includes the fix. */
export class SandboxUnavailableError extends Error {
  constructor(readonly probe: SandboxProbe) {
    const failures = probe.attempts.map((a) => `  ${a.kind}: ${a.error}`);
    super(
      [
        "No local sandbox works here, so port-anything won't run generated cases.",
        ...failures,
        'To fix it, pick one:',
        probe.fix ?? '',
      ].join('\n'),
    );
    this.name = 'SandboxUnavailableError';
  }
}

/** Picks the sandbox for a run: the probed one, `none` with `--no-sandbox`, or a refusal. */
export function chooseSandbox(probe: SandboxProbe, options: { noSandbox?: boolean } = {}): SandboxChoice {
  const setup: SandboxSetup | undefined = options.noSandbox ? { kind: 'none' } : probe.usable;
  if (setup === undefined) throw new SandboxUnavailableError(probe);
  return { ...setup, label: label(setup) };
}

/** This machine. */
export function localHost(): SandboxHost {
  return {
    platform: process.platform,
    tempDir: tmpdir(),
    inContainer: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
    run: (command, args, cwd) =>
      new Promise((resolve) => {
        // Descriptor 3 is open as in a real case, for bwrap's status output.
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 10_000);
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.stdio[3]!.on('data', () => {}).on('error', () => {});
        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (error.code === 'ENOENT') resolve({ ok: false, message: `${command} is not installed`, missing: true });
          else resolve({ ok: false, message: error.message });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) return resolve({ ok: true });
          const firstLine = stderr.split('\n').find((line) => line.trim() !== '')?.trim();
          resolve({ ok: false, message: firstLine ?? (timedOut ? 'timed out' : `exited with ${signal ?? `code ${code}`}`) });
        });
      }),
    readSetting: (path) => readFile(path, 'utf8').then((s) => s.trim(), () => undefined),
  };
}

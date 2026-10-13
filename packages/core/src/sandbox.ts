import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * How a case runs locally:
 * - `bwrap`: bubblewrap. Read-only view of the system, writable case workdir, private `/tmp`, no network.
 * - `unshare`: fallback when bwrap isn't usable. No network, but the filesystem is not isolated.
 * - `none`: no isolation at all; only with `--no-sandbox`.
 *
 * Neither is a strong security boundary: they keep a trusted program from touching the network or
 * (with bwrap) files outside its workdir by accident.
 */
export type SandboxKind = 'bwrap' | 'unshare' | 'none';

/** A sandbox that isolates something; what the probe looks for. */
export type LocalSandbox = Exclude<SandboxKind, 'none'>;

/** The process to spawn for one case. */
export interface SandboxCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** Wraps `argv` so it runs in `workdir` (an absolute path) inside the given sandbox. */
export function sandboxCommand(kind: SandboxKind, argv: readonly string[], workdir: string): SandboxCommand {
  if (argv.length === 0) throw new Error('Cannot run an empty argv.');
  if (!isAbsolute(workdir)) throw new Error(`The case workdir must be an absolute path, got "${workdir}".`);
  switch (kind) {
    case 'bwrap':
      return {
        command: 'bwrap',
        args: [
          // Order matters: later mounts go on top, so the workdir bind must follow the /tmp tmpfs.
          ...['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'],
          ...['--bind', workdir, workdir, '--chdir', workdir],
          // No PID namespace: mounting a fresh /proc for one fails inside Docker, where Linux CI and
          // the dev container run. (--unshare-all would include it.)
          ...['--unshare-user', '--unshare-ipc', '--unshare-uts', '--unshare-net'],
          ...['--die-with-parent', '--new-session'],
          '--',
          ...argv,
        ],
        cwd: workdir,
      };
    case 'unshare':
      // --map-current-user rather than -r: as uid 0, programs would skip permission checks.
      return { command: 'unshare', args: ['--user', '--map-current-user', '--net', '--', ...argv], cwd: workdir };
    case 'none':
      return { command: argv[0]!, args: argv.slice(1), cwd: workdir };
  }
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
  /** Why it failed: the tool's own message. */
  error?: string;
}

export interface SandboxProbe {
  /** The best sandbox that works here, if any. */
  usable: LocalSandbox | undefined;
  attempts: SandboxAttempt[];
  /** When nothing works: what to do about it, ready to print. */
  fix: string | undefined;
}

const PROBE_ORDER: Record<string, LocalSandbox[]> = { linux: ['bwrap', 'unshare'] };

/**
 * Finds out which local sandbox works by running `true` in each, with exactly the arguments real
 * cases get. Run once at start-up: Ubuntu 24.04+ (AppArmor), Docker's default seccomp profile and
 * some kernels' sysctls all block the unprivileged user namespaces both tools need.
 */
export async function probeSandbox(host: SandboxHost = localHost()): Promise<SandboxProbe> {
  const attempts: SandboxAttempt[] = [];
  const missing = new Set<LocalSandbox>();
  for (const kind of PROBE_ORDER[host.platform] ?? []) {
    const { command, args, cwd } = sandboxCommand(kind, ['true'], host.tempDir);
    const result = await host.run(command, args, cwd);
    if (result.ok) {
      attempts.push({ kind, ok: true });
      return { usable: kind, attempts, fix: undefined };
    }
    attempts.push({ kind, ok: false, error: result.message });
    if (result.missing) missing.add(kind);
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

/** The sandbox a run uses, as the report's "sandbox used" field shows it. */
export interface SandboxChoice {
  kind: SandboxKind;
  label: string;
}

const LABELS: Record<SandboxKind, string> = {
  bwrap: 'bwrap, no network',
  unshare: 'unshare, no network (filesystem not isolated)',
  none: 'none (--no-sandbox)',
};

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
  const kind = options.noSandbox ? 'none' : probe.usable;
  if (kind === undefined) throw new SandboxUnavailableError(probe);
  return { kind, label: LABELS[kind] };
}

/** This machine. */
export function localHost(): SandboxHost {
  return {
    platform: process.platform,
    tempDir: tmpdir(),
    inContainer: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
    run: (command, args, cwd) =>
      new Promise((resolve) => {
        execFile(command, args, { cwd, timeout: 10_000 }, (error, _stdout, stderr) => {
          if (!error) return resolve({ ok: true });
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return resolve({ ok: false, message: `${command} is not installed`, missing: true });
          const firstLine = stderr.split('\n').find((line) => line.trim() !== '')?.trim();
          resolve({ ok: false, message: firstLine ?? (error.killed ? 'timed out' : error.message) });
        });
      }),
    readSetting: (path) => readFile(path, 'utf8').then((s) => s.trim(), () => undefined),
  };
}

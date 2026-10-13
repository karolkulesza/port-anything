import { describe, expect, it } from 'vitest';
import {
  SandboxUnavailableError,
  chooseSandbox,
  probeSandbox,
  sandboxCommand,
  type SandboxHost,
} from '../src/sandbox.js';

type Outcome = { ok: true } | { ok: false; message: string; missing?: boolean };

// A host where each sandbox tool succeeds or fails as told, with the given sysctl values.
function fakeHost(opts: {
  platform?: NodeJS.Platform;
  bwrap?: Outcome | ((args: readonly string[]) => Outcome);
  unshare?: Outcome | ((args: readonly string[]) => Outcome);
  settings?: Record<string, string>;
  inContainer?: boolean;
}): SandboxHost & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    platform: opts.platform ?? 'linux',
    tempDir: '/tmp',
    inContainer: opts.inContainer ?? false,
    async run(command, args) {
      calls.push([command, ...args]);
      const outcome = (command === 'bwrap' ? opts.bwrap : opts.unshare) ?? { ok: true };
      return typeof outcome === 'function' ? outcome(args) : outcome;
    },
    async readSetting(path) {
      return opts.settings?.[path];
    },
  };
}

const BWRAP = { kind: 'bwrap', isolatePids: true } as const;
const NO_USERNS = 'No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.';

describe('sandboxCommand', () => {
  it('runs bwrap with a read-only system, a writable workdir, a private /tmp and /run, no network', () => {
    const cmd = sandboxCommand(BWRAP, ['sort', '-r', 'in.txt'], '/tmp/case-1');
    expect(cmd.command).toBe('bwrap');
    expect(cmd.cwd).toBe('/tmp/case-1');
    const args = cmd.args.join(' ');
    expect(args).toContain('--ro-bind / /');
    expect(args).toContain('--tmpfs /tmp');
    expect(args).toContain('--tmpfs /run');
    expect(args).toContain('--bind /tmp/case-1 /tmp/case-1');
    expect(args).toContain('--chdir /tmp/case-1');
    expect(cmd.args).toContain('--unshare-net');
    expect(cmd.args).toContain('--unshare-pid');
    expect(cmd.args).toContain('--die-with-parent');
    // The workdir bind comes after the tmpfs mounts, or they would hide it.
    expect(cmd.args.indexOf('--bind')).toBeGreaterThan(cmd.args.lastIndexOf('--tmpfs'));
    expect(cmd.args.slice(-4)).toEqual(['--', 'sort', '-r', 'in.txt']);
  });

  it('leaves out the PID namespace only when told to', () => {
    expect(sandboxCommand({ kind: 'bwrap', isolatePids: false }, ['true'], '/w').args).not.toContain('--unshare-pid');
  });

  it('runs unshare with a new user and network namespace, as the current user when it can', () => {
    const mapped = sandboxCommand({ kind: 'unshare', mapCurrentUser: true }, ['sort'], '/w');
    expect(mapped).toEqual({ command: 'unshare', args: ['--user', '--map-current-user', '--net', '--', 'sort'], cwd: '/w' });
    const unmapped = sandboxCommand({ kind: 'unshare', mapCurrentUser: false }, ['sort'], '/w');
    expect(unmapped.args).toEqual(['--user', '--net', '--', 'sort']);
  });

  it('runs the program directly without a sandbox', () => {
    expect(sandboxCommand({ kind: 'none' }, ['sort', '-n'], '/w')).toEqual({ command: 'sort', args: ['-n'], cwd: '/w' });
  });

  it('rejects a relative workdir and an empty argv', () => {
    expect(() => sandboxCommand(BWRAP, ['true'], 'case-1')).toThrow(/absolute/);
    expect(() => sandboxCommand({ kind: 'none' }, [], '/w')).toThrow(/empty/);
  });
});

describe('probeSandbox', () => {
  it('prefers bwrap with a PID namespace and tries it with the same arguments cases get', async () => {
    const host = fakeHost({});
    const probe = await probeSandbox(host);
    expect(probe.usable).toEqual(BWRAP);
    expect(probe.attempts).toEqual([{ kind: 'bwrap', ok: true }]);
    expect(probe.fix).toBeUndefined();
    expect(host.calls).toEqual([['bwrap', ...sandboxCommand(BWRAP, ['true'], '/tmp').args]]);
  });

  it('drops the PID namespace when bwrap cannot mount a fresh /proc (Docker)', async () => {
    const host = fakeHost({
      bwrap: (args) =>
        args.includes('--unshare-pid') ? { ok: false, message: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" } : { ok: true },
    });
    const probe = await probeSandbox(host);
    expect(probe.usable).toEqual({ kind: 'bwrap', isolatePids: false });
    expect(host.calls).toHaveLength(2);
    expect(chooseSandbox(probe).label).toBe('bwrap, no network (processes not isolated)');
  });

  it('runs unshare without --map-current-user on util-linux before 2.38', async () => {
    const probe = await probeSandbox(
      fakeHost({
        bwrap: { ok: false, message: 'bwrap is not installed', missing: true },
        unshare: (args) =>
          args.includes('--map-current-user') ? { ok: false, message: "unshare: unrecognized option '--map-current-user'" } : { ok: true },
      }),
    );
    expect(probe.usable).toEqual({ kind: 'unshare', mapCurrentUser: false });
  });

  it('tries a missing tool once', async () => {
    const host = fakeHost({ bwrap: { ok: false, message: 'bwrap is not installed', missing: true } });
    await probeSandbox(host);
    expect(host.calls.map((c) => c[0])).toEqual(['bwrap', 'unshare']);
  });

  it('falls back to unshare when bwrap fails', async () => {
    const probe = await probeSandbox(fakeHost({ bwrap: { ok: false, message: 'bwrap is not installed', missing: true } }));
    expect(probe.usable).toEqual({ kind: 'unshare', mapCurrentUser: true });
    expect(probe.attempts.map((a) => [a.kind, a.ok])).toEqual([['bwrap', false], ['unshare', true]]);
  });

  it('finds nothing usable when user namespaces are blocked, and explains the AppArmor fix first', async () => {
    const probe = await probeSandbox(
      fakeHost({
        bwrap: { ok: false, message: `bwrap: ${NO_USERNS}` },
        unshare: { ok: false, message: 'unshare: unshare failed: Operation not permitted' },
        settings: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' },
      }),
    );
    expect(probe.usable).toBeUndefined();
    const fix = probe.fix!;
    expect(fix).toContain('apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict');
    expect(fix).toContain('sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
    expect(fix.indexOf('apparmor_parser')).toBeLessThan(fix.indexOf('sysctl -w'));
    expect(fix.indexOf('sysctl -w')).toBeLessThan(fix.indexOf('--no-sandbox'));
  });

  it('names the sysctl that disables user namespaces on Debian and elsewhere', async () => {
    const failing = { bwrap: { ok: false, message: NO_USERNS }, unshare: { ok: false, message: 'EPERM' } } as const;
    const debian = await probeSandbox(fakeHost({ ...failing, settings: { '/proc/sys/kernel/unprivileged_userns_clone': '0' } }));
    expect(debian.fix).toContain('sysctl -w kernel.unprivileged_userns_clone=1');
    const zero = await probeSandbox(fakeHost({ ...failing, settings: { '/proc/sys/user/max_user_namespaces': '0' } }));
    expect(zero.fix).toContain('sysctl -w user.max_user_namespaces=');
  });

  it('suggests installing bubblewrap when it is missing', async () => {
    const probe = await probeSandbox(
      fakeHost({
        bwrap: { ok: false, message: 'bwrap is not installed', missing: true },
        unshare: { ok: false, message: 'EPERM' },
      }),
    );
    expect(probe.fix).toMatch(/install bubblewrap/i);
  });

  it("points at Docker's seccomp profile inside a container", async () => {
    const probe = await probeSandbox(
      fakeHost({ bwrap: { ok: false, message: NO_USERNS }, unshare: { ok: false, message: 'EPERM' }, inContainer: true }),
    );
    expect(probe.fix).toContain('--security-opt seccomp=unconfined');
  });

  it('has no local sandbox on other platforms yet, and runs nothing there', async () => {
    const host = fakeHost({ platform: 'win32' });
    const probe = await probeSandbox(host);
    expect(probe.usable).toBeUndefined();
    expect(probe.attempts).toEqual([]);
    expect(host.calls).toEqual([]);
    expect(probe.fix).toContain('--no-sandbox');
  });
});

describe('chooseSandbox', () => {
  it('uses the probed sandbox and labels it for the report', async () => {
    const choice = chooseSandbox(await probeSandbox(fakeHost({})));
    expect(choice).toEqual({ kind: 'bwrap', isolatePids: true, label: 'bwrap, no network' });
  });

  it('says when the filesystem is not isolated (unshare fallback)', async () => {
    const choice = chooseSandbox(await probeSandbox(fakeHost({ bwrap: { ok: false, message: 'x', missing: true } })));
    expect(choice.kind).toBe('unshare');
    expect(choice.label).toBe('unshare, no network (filesystem not isolated)');
  });

  it('refuses when nothing works, printing what failed and the fix', async () => {
    const probe = await probeSandbox(
      fakeHost({ bwrap: { ok: false, message: `bwrap: ${NO_USERNS}` }, unshare: { ok: false, message: 'unshare: EPERM' } }),
    );
    let error: unknown;
    try {
      chooseSandbox(probe);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SandboxUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain('No local sandbox works here');
    expect(message).toContain(`bwrap: bwrap: ${NO_USERNS}`);
    expect(message).toContain('unshare: unshare: EPERM');
    expect(message).toContain(probe.fix!);
    expect((error as SandboxUnavailableError).probe).toBe(probe);
  });

  it('runs without a sandbox only when asked to', async () => {
    const broken = await probeSandbox(fakeHost({ bwrap: { ok: false, message: 'x' }, unshare: { ok: false, message: 'y' } }));
    expect(chooseSandbox(broken, { noSandbox: true })).toEqual({ kind: 'none', label: 'none (--no-sandbox)' });
    // --no-sandbox is honored even when a sandbox would work.
    expect(chooseSandbox(await probeSandbox(fakeHost({})), { noSandbox: true }).kind).toBe('none');
  });
});

import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxHost } from '../../src/sandbox.js';

// A classic-BPF seccomp filter that makes creating a user namespace fail with EPERM, the way
// Docker's default profile and kernels with userns disabled do. clone3 returns ENOSYS so libc
// falls back to clone, whose flags a classic filter can inspect.
const AUDIT_ARCH: Partial<Record<NodeJS.Architecture, { arch: number; unshare: number; clone: number }>> = {
  x64: { arch: 0xc000003e, unshare: 272, clone: 56 },
  arm64: { arch: 0xc00000b7, unshare: 97, clone: 220 },
};
const CLONE3 = 435; // same number on every architecture
const CLONE_NEWUSER = 0x10000000;
const LD_W_ABS = 0x20, JEQ_K = 0x15, JSET_K = 0x45, RET_K = 0x06;
const ALLOW = 0x7fff0000, ERRNO = 0x00050000, EPERM = 1, ENOSYS = 38;

function filter(): Buffer {
  const a = AUDIT_ARCH[process.arch];
  if (!a) throw new Error(`No seccomp filter for ${process.arch}.`);
  const op = (code: number, jt: number, jf: number, k: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(code, 0);
    b.writeUInt8(jt, 2);
    b.writeUInt8(jf, 3);
    b.writeUInt32LE(k >>> 0, 4);
    return b;
  };
  return Buffer.concat([
    op(LD_W_ABS, 0, 0, 4), // seccomp_data.arch
    op(JEQ_K, 1, 0, a.arch),
    op(RET_K, 0, 0, ALLOW),
    op(LD_W_ABS, 0, 0, 0), // seccomp_data.nr
    op(JEQ_K, 0, 1, CLONE3),
    op(RET_K, 0, 0, ERRNO | ENOSYS),
    op(JEQ_K, 1, 0, a.unshare),
    op(JEQ_K, 0, 3, a.clone),
    op(LD_W_ABS, 0, 0, 16), // low 32 bits of args[0]: the flags of both unshare and clone
    op(JSET_K, 0, 1, CLONE_NEWUSER),
    op(RET_K, 0, 0, ERRNO | EPERM),
    op(RET_K, 0, 0, ALLOW),
  ]);
}

/**
 * The real machine, except that every probe command runs under bwrap with the filter above, so
 * the sandbox tools inside it can't create user namespaces.
 */
export function hostWithoutUserNamespaces(real: SandboxHost): SandboxHost {
  const path = join(mkdtempSync(join(tmpdir(), 'no-userns-')), 'filter.bpf');
  writeFileSync(path, filter());
  return {
    ...real,
    run: (command, args, cwd) =>
      new Promise((resolve) => {
        const fd = openSync(path, 'r');
        const child = spawn('bwrap', ['--bind', '/', '/', '--dev', '/dev', '--seccomp', '3', '--', command, ...args], {
          cwd,
          stdio: ['ignore', 'ignore', 'pipe', fd],
        });
        let stderr = '';
        child.stderr!.on('data', (chunk) => (stderr += chunk));
        child.on('error', (error) => {
          closeSync(fd);
          resolve({ ok: false, message: error.message });
        });
        child.on('close', (code) => {
          closeSync(fd);
          if (code === 0) return resolve({ ok: true });
          resolve({ ok: false, message: stderr.split('\n').find((l) => l.trim() !== '')?.trim() ?? `exit code ${code}` });
        });
      }),
  };
}

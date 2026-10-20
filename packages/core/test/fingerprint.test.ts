import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerError } from '../src/container.js';
import { containerFingerprint, environmentFingerprint, fingerprintDifferences, localFingerprintHost, type FingerprintHost } from '../src/fingerprint.js';
import type { ResolvedProgram } from '../src/program.js';

const DEBIAN: FingerprintHost = {
  platform: 'linux',
  release: '6.8.0-45-generic',
  arch: 'x64',
  osRelease: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
  glibc: '2.36',
};
const MACOS: FingerprintHost = { platform: 'darwin', release: '24.6.0', arch: 'arm64', osRelease: undefined, glibc: undefined };

describe('environmentFingerprint', () => {
  let dir: string;
  let reference: ResolvedProgram;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-fingerprint-')));
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    reference = { executable: join(dir, 'tool'), args: [], path: join(dir, 'tool'), realPath: join(dir, 'tool') };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names the distro, the C library and the locale on Linux, and hashes the reference', async () => {
    const fp = await environmentFingerprint({ reference, caseEnv: { LANG: 'C.UTF-8' }, host: DEBIAN });
    expect(fp).toEqual({
      mode: 'local',
      os: 'linux debian 12',
      arch: 'x64',
      libc: 'glibc 2.36',
      locale: 'C.UTF-8',
      reference: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('uses the Darwin release on macOS, LC_ALL over LANG, and no libc', async () => {
    const fp = await environmentFingerprint({ reference, caseEnv: { LANG: 'C.UTF-8', LC_ALL: 'C' }, host: MACOS });
    expect(fp).toMatchObject({ os: 'darwin 24.6.0', arch: 'arm64', libc: null, locale: 'C' });
  });

  it('changes when the reference executable changes, and says which fields differ', async () => {
    const before = await environmentFingerprint({ reference, caseEnv: {}, host: DEBIAN });
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\necho bye\n');
    const after = await environmentFingerprint({ reference, caseEnv: {}, host: DEBIAN });
    expect(before.locale).toBeNull();
    expect(fingerprintDifferences(before, after)).toEqual(['reference']);
    expect(fingerprintDifferences(before, { ...after, os: 'linux ubuntu 24.04', reference: before.reference })).toEqual(['os']);
    expect(fingerprintDifferences(before, before)).toEqual([]);
  });

  it('reads this machine', async () => {
    const host = await localFingerprintHost();
    expect(host.platform).toBe(process.platform);
    expect(host.arch).toBe(process.arch);
  });
});

describe('containerFingerprint', () => {
  let dir: string;
  /** A stand-in engine that answers `image inspect` with `answer`, and fails with `fail` set. */
  const engine = (answer: string, fail = false) => {
    const path = join(dir, `engine-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, `#!/bin/sh\necho '${answer}'\n${fail ? 'exit 1\n' : ''}`, { mode: 0o755 });
    return path;
  };
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-fingerprint-')));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("names the image by the digest of the repository it was pulled from, with its architecture and the cases' locale", async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const fp = await containerFingerprint(
      { engine: engine(`["mirror.example/debian@sha256:${'b'.repeat(64)}","debian@${digest}"] sha256:${'c'.repeat(64)} arm64`), image: 'debian:12-slim' },
      { LANG: 'C.UTF-8' },
    );
    expect(fp).toEqual({ mode: 'container', image: `debian@${digest}`, arch: 'arm64', locale: 'C.UTF-8' });
  });

  it('uses the image ID for an image that was never pulled, and differs from any local fingerprint', async () => {
    const id = `sha256:${'c'.repeat(64)}`;
    const fp = await containerFingerprint({ engine: engine(`[] ${id} amd64`), image: 'my-image' }, {});
    expect(fp).toEqual({ mode: 'container', image: id, arch: 'amd64', locale: null });
    expect(await containerFingerprint({ engine: engine(`null ${id} amd64`), image: 'my-image' }, {})).toEqual(fp);
    expect(fingerprintDifferences(fp, { ...fp, arch: 'arm64' })).toEqual(['arch']);
    const local = { mode: 'local' as const, os: 'linux debian 12', arch: 'amd64', libc: 'glibc 2.36', locale: null, reference: id };
    expect(fingerprintDifferences(local, fp)).toEqual(['mode', 'os', 'libc', 'reference', 'image']);
  });

  it('throws a ContainerError when the engine cannot inspect the image', async () => {
    await expect(containerFingerprint({ engine: engine('Error: No such image: nope', true), image: 'nope' }, {})).rejects.toThrow(ContainerError);
  });
});

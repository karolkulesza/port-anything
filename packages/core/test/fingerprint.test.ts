import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { environmentFingerprint, fingerprintDifferences, localFingerprintHost, type FingerprintHost } from '../src/fingerprint.js';
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

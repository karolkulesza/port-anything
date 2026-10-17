import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { z } from 'zod';
import type { ResolvedProgram } from './program.js';

/**
 * What the reference's observations depend on besides the cases: in local mode the OS (the distro
 * on Linux), the CPU architecture, the C library, the locale the cases run under and the reference
 * executable itself. Observations are only comparable between runs with the same fingerprint.
 */
export const FingerprintSchema = z.strictObject({
  mode: z.literal('local'),
  /** `linux debian 12`, `darwin 24.6.0` (the Darwin release follows the macOS version). */
  os: z.string(),
  arch: z.string(),
  /** `glibc 2.36`; null when there is no glibc (macOS, musl). */
  libc: z.string().nullable(),
  /** `LC_ALL`, else `LANG`, as the cases see it; null when neither is set. */
  locale: z.string().nullable(),
  /** `sha256:<hex>` of the file the reference runs (a script run directly is hashed itself; `python3 tool.py` hashes python3). */
  reference: z.string(),
});

export type Fingerprint = z.output<typeof FingerprintSchema>;

/** Where the fingerprint's facts about the machine come from; tests pass their own. */
export interface FingerprintHost {
  platform: string;
  release: string;
  arch: string;
  /** Contents of `/etc/os-release`, or undefined when there is none. */
  osRelease: string | undefined;
  /** glibc's version, or undefined without glibc. */
  glibc: string | undefined;
}

export async function localFingerprintHost(): Promise<FingerprintHost> {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    osRelease: platform() === 'linux' ? await readFile('/etc/os-release', 'utf8').catch(() => undefined) : undefined,
    glibc: header?.glibcVersionRuntime,
  };
}

/** `ID` and `VERSION_ID` from `/etc/os-release` (`debian 12`), or undefined when it has no ID. */
function distro(osRelease: string): string | undefined {
  const field = (name: string) => {
    const match = new RegExp(`^${name}=(.*)$`, 'm').exec(osRelease);
    return match?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
  };
  const id = field('ID');
  if (id === undefined || id === '') return undefined;
  const version = field('VERSION_ID');
  return version === undefined || version === '' ? id : `${id} ${version}`;
}

export interface FingerprintOptions {
  reference: ResolvedProgram;
  /** The variables the cases run with (see `caseEnvironment`). */
  caseEnv: Readonly<Record<string, string>>;
  host?: FingerprintHost;
}

/** This machine's fingerprint for running `reference` in local mode. */
export async function environmentFingerprint(options: FingerprintOptions): Promise<Fingerprint> {
  const host = options.host ?? (await localFingerprintHost());
  const os = host.platform === 'linux' && host.osRelease !== undefined ? distro(host.osRelease) : undefined;
  return {
    mode: 'local',
    os: `${host.platform} ${os ?? host.release}`,
    arch: host.arch,
    libc: host.glibc === undefined ? null : `glibc ${host.glibc}`,
    locale: options.caseEnv.LC_ALL ?? options.caseEnv.LANG ?? null,
    reference: `sha256:${createHash('sha256').update(await readFile(options.reference.realPath)).digest('hex')}`,
  };
}

/** The fields in which two fingerprints differ, in schema order; none when they match. */
export function fingerprintDifferences(a: Fingerprint, b: Fingerprint): (keyof Fingerprint)[] {
  return (Object.keys(FingerprintSchema.shape) as (keyof Fingerprint)[]).filter((key) => a[key] !== b[key]);
}

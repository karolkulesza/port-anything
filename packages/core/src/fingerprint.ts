import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { z } from 'zod';
import { ContainerError, engineCommand, type ContainerSetup } from './container.js';
import type { ResolvedProgram } from './program.js';

/**
 * What the reference's observations depend on besides the cases: in local mode the OS (the distro
 * on Linux), the CPU architecture, the C library, the locale the cases run under and the reference
 * executable itself. Observations are only comparable between runs with the same fingerprint.
 */
export const LocalFingerprintSchema = z.strictObject({
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

/**
 * In container mode, the image fixes the OS, the C library and the tools, and the reference is
 * built in it from the committed source: the image's digest stands for all of them, with the
 * architecture it runs on (a multi-platform image has one digest for all its platforms) and the
 * locale the cases run under.
 */
export const ContainerFingerprintSchema = z.strictObject({
  mode: z.literal('container'),
  /** `debian@sha256:<hex>` for a pulled image; `sha256:<hex>` (its ID) for one built locally. */
  image: z.string(),
  /** The image's platform architecture as the engine reports it (`amd64`, `arm64`). */
  arch: z.string(),
  locale: z.string().nullable(),
});

export const FingerprintSchema = z.discriminatedUnion('mode', [LocalFingerprintSchema, ContainerFingerprintSchema]);

export type Fingerprint = z.output<typeof FingerprintSchema>;
export type LocalFingerprint = z.output<typeof LocalFingerprintSchema>;
export type ContainerFingerprint = z.output<typeof ContainerFingerprintSchema>;
/** A field of either kind of fingerprint. */
export type FingerprintField = keyof LocalFingerprint | keyof ContainerFingerprint;

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

/** `LC_ALL`, else `LANG`, as the cases see it. */
const caseLocale = (caseEnv: Readonly<Record<string, string>>) => caseEnv.LC_ALL ?? caseEnv.LANG ?? null;

export interface FingerprintOptions {
  reference: ResolvedProgram;
  /** The variables the cases run with (see `caseEnvironment`). */
  caseEnv: Readonly<Record<string, string>>;
  host?: FingerprintHost;
}

/** This machine's fingerprint for running `reference` in local mode. */
export async function environmentFingerprint(options: FingerprintOptions): Promise<LocalFingerprint> {
  const host = options.host ?? (await localFingerprintHost());
  const os = host.platform === 'linux' && host.osRelease !== undefined ? distro(host.osRelease) : undefined;
  return {
    mode: 'local',
    os: `${host.platform} ${os ?? host.release}`,
    arch: host.arch,
    libc: host.glibc === undefined ? null : `glibc ${host.glibc}`,
    locale: caseLocale(options.caseEnv),
    reference: `sha256:${createHash('sha256').update(await readFile(options.reference.realPath)).digest('hex')}`,
  };
}

/**
 * This image's fingerprint for running cases in container mode. Throws a `ContainerError` when the
 * engine can't inspect the image.
 */
export async function containerFingerprint(setup: Pick<ContainerSetup, 'engine' | 'image'>, caseEnv: Readonly<Record<string, string>>): Promise<ContainerFingerprint> {
  const inspected = await engineCommand(setup.engine, ['image', 'inspect', '--format', '{{json .RepoDigests}} {{.Id}} {{.Architecture}}', setup.image]);
  const match = /^(null|\[.*\]) (\S+) (\S+)$/.exec(inspected.output);
  if (!inspected.ok || match === null) throw new ContainerError(`Cannot inspect the image ${setup.image} (sandbox.image):\n${inspected.output}`);
  const digests = (JSON.parse(match[1]!) as string[] | null) ?? [];
  // The digest of the repository the image was named by, else any; the ID when it was never pulled.
  const repository = setup.image.replace(/@.*$/, '').replace(/:[^/:]*$/, '');
  const digest = digests.find((d) => d.startsWith(`${repository}@`)) ?? digests[0];
  return { mode: 'container', image: digest ?? match[2]!, arch: match[3]!, locale: caseLocale(caseEnv) };
}

const FIELDS: readonly FingerprintField[] = [...new Set([...Object.keys(LocalFingerprintSchema.shape), ...Object.keys(ContainerFingerprintSchema.shape)] as FingerprintField[])];

/** The value of a field, or undefined when this kind of fingerprint has no such field. */
export function fingerprintField(fp: Fingerprint, field: FingerprintField): string | null | undefined {
  return (fp as Partial<Record<FingerprintField, string | null>>)[field];
}

/** The fields in which two fingerprints differ (a field only one kind has counts), in schema order; none when they match. */
export function fingerprintDifferences(a: Fingerprint, b: Fingerprint): FingerprintField[] {
  return FIELDS.filter((key) => fingerprintField(a, key) !== fingerprintField(b, key));
}

import { randomBytes } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConfigError,
  ContainerError,
  DEFAULT_CONTAINER_IMAGE,
  buildInImage,
  configCandidates,
  containerFingerprint,
  containerSandbox,
  engineCpus,
  ensureImage,
  environmentFingerprint,
  findContainerEngine,
  parseProgramCommand,
  resolveProgram,
  type Config,
  type Fingerprint,
  type ResolvedProgram,
  type SandboxChoice,
} from '@port-anything/core';

/** What a CLI command returns: the exit code and what to print. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A program from the config or the command line; relative paths start at the project directory.
 * With `build`, the config's build command for it, a program that can't be found or run says to
 * build it with that command: in sandbox mode local nothing builds it.
 */
export async function resolveCommand(cmd: string | readonly string[], projectDir: string, build?: ConfiguredBuild): Promise<ResolvedProgram> {
  try {
    return await resolveProgram(parseProgramCommand(cmd), { cwd: projectDir });
  } catch (e) {
    const hint = build === undefined ? '' : ` Build it with \`${build.command}\` (${build.key} in port-anything.yaml; only sandbox mode container runs the build commands).`;
    throw new ConfigError(`${(e as Error).message}${hint}`);
  }
}

/** The config's reference, with `resolveCommand`'s build hint in sandbox mode local. */
export async function resolveReference(config: Config, projectDir: string): Promise<ResolvedProgram> {
  return resolveCommand(config.reference.cmd, projectDir, config.sandbox.mode === 'container' ? undefined : configuredBuilds(config, []).reference);
}

/** A build command from the config, with its key for messages. */
export interface ConfiguredBuild {
  key: string;
  command: string;
}

/**
 * The build command of the reference, and of each of `commands` that is a configured candidate (a
 * candidate given only on the command line has none), in the order of `commands`.
 */
export function configuredBuilds(config: Config, commands: readonly (string | readonly string[])[]): { reference?: ConfiguredBuild; candidates: (ConfiguredBuild | undefined)[] } {
  const same = (a: string | readonly string[], b: string | readonly string[]) => JSON.stringify(a) === JSON.stringify(b);
  const configured = configCandidates(config);
  const candidates = commands.map((cmd) => {
    const i = configured.findIndex((c) => same(c.cmd, cmd));
    const build = configured[i]?.build;
    return build === undefined ? undefined : { key: config.candidates === undefined ? 'candidate.build' : `candidates.${i}.build`, command: build };
  });
  return { ...(config.reference.build === undefined ? {} : { reference: { key: 'reference.build', command: config.reference.build } }), candidates };
}

/**
 * Runs `use` with a fresh scratch directory inside the project rather than /tmp, which may be
 * mounted noexec, and removes it afterwards.
 */
export async function withScratchDir<T>(projectDir: string, label: string, use: (dir: string) => Promise<T>): Promise<T> {
  const workDir = join(projectDir, '.port-anything', 'tmp', `${label}-${randomBytes(6).toString('hex')}`);
  try {
    return await use(workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rmdir(join(projectDir, '.port-anything', 'tmp')).catch(() => {}); // kept while another command uses it
  }
}

/** A command as the user wrote it; an argv list is shown with quotes around words with spaces. */
export function display(cmd: string | readonly string[]): string {
  return typeof cmd === 'string' ? cmd : cmd.map((w) => (/[\s'"]/.test(w) || w === '' ? `'${w}'` : w)).join(' ');
}

/**
 * Sandbox mode `container`: finds Docker or Podman, pulls the image if needed, and runs in it the
 * build command of the reference and of each configured candidate among `commands`, so the
 * programs are built for the image (a candidate given only on the command line isn't built). Every
 * program must then be a path: a bare name would be looked up on the host's PATH, and the host's
 * program may not run in the image. Failures are `ConfigError`s.
 */
export async function prepareContainer(
  projectDir: string,
  config: Config,
  commands: readonly (string | readonly string[])[],
  options: { noSandbox: boolean },
): Promise<SandboxChoice> {
  if (options.noSandbox) {
    throw new ConfigError('--no-sandbox is for sandbox mode local: in sandbox mode "container", cases always run in containers.');
  }
  for (const cmd of [config.reference.cmd, ...commands]) {
    const { executable } = parseProgramCommand(cmd);
    if (!executable.includes('/')) {
      throw new ConfigError(`In sandbox mode "container", give each program as a path (./${executable} or an absolute path): "${executable}" would be looked up on the host's PATH, not in the image.`);
    }
  }
  const image = config.sandbox.image ?? DEFAULT_CONTAINER_IMAGE;
  try {
    const engine = await findContainerEngine();
    await ensureImage(engine, image);
    const cpus = await engineCpus(engine);
    const sandbox = containerSandbox({ engine, image, ...(cpus === undefined ? {} : { cpus }) });
    const { reference, candidates } = configuredBuilds(config, commands);
    const builds = new Map([reference, ...candidates].filter((b) => b !== undefined).map((b) => [b.key, b.command])); // each once
    for (const [key, command] of builds) {
      const built = await buildInImage({ kind: 'container', engine, image }, projectDir, command);
      if (!built.ok) throw new ConfigError(`${key} failed in the image ${image}: ${command}\n${built.output}`);
    }
    return sandbox;
  } catch (e) {
    if (e instanceof ContainerError) throw new ConfigError(e.message);
    throw e;
  }
}

/**
 * The environment fingerprint of running `reference` in `sandbox`: the image's in sandbox mode
 * `container`, this machine's otherwise.
 */
export async function sandboxFingerprint(sandbox: SandboxChoice, reference: ResolvedProgram, caseEnv: Readonly<Record<string, string>>): Promise<Fingerprint> {
  if (sandbox.kind !== 'container') return environmentFingerprint({ reference, caseEnv });
  try {
    return await containerFingerprint(sandbox, caseEnv);
  } catch (e) {
    if (e instanceof ContainerError) throw new ConfigError(e.message);
    throw e;
  }
}

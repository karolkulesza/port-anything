import { randomBytes } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConfigError,
  ContainerError,
  DEFAULT_CONTAINER_IMAGE,
  buildInImage,
  configCandidates,
  containerSandbox,
  engineCpus,
  ensureImage,
  findContainerEngine,
  parseProgramCommand,
  resolveProgram,
  type Config,
  type ResolvedProgram,
  type SandboxChoice,
} from '@port-anything/core';

/** What a CLI command returns: the exit code and what to print. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A program from the config or the command line; relative paths start at the project directory. */
export async function resolveCommand(cmd: string | readonly string[], projectDir: string): Promise<ResolvedProgram> {
  try {
    return await resolveProgram(parseProgramCommand(cmd), { cwd: projectDir });
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
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
    // Retries: files containers wrote in it can show up on the host while it goes (ENOTEMPTY).
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    const same = (a: string | readonly string[], b: string | readonly string[]) => JSON.stringify(a) === JSON.stringify(b);
    const builds = [
      ...(config.reference.build === undefined ? [] : [{ key: 'reference.build', command: config.reference.build }]),
      ...configCandidates(config).flatMap((c, i) =>
        c.build !== undefined && commands.some((cmd) => same(cmd, c.cmd))
          ? [{ key: config.candidates === undefined ? 'candidate.build' : `candidates.${i}.build`, command: c.build }]
          : [],
      ),
    ];
    for (const { key, command } of builds) {
      const built = await buildInImage({ kind: 'container', engine, image }, projectDir, command);
      if (!built.ok) throw new ConfigError(`${key} failed in the image ${image}: ${command}\n${built.output}`);
    }
    return sandbox;
  } catch (e) {
    if (e instanceof ContainerError) throw new ConfigError(e.message);
    throw e;
  }
}

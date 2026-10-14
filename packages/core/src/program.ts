import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * Binaries that hold many tools and pick one by the name they run as (argv[0]). `'coreutils sort'`
 * means the `sort` tool of such a binary.
 */
export const MULTICALL_BINARIES: readonly string[] = Object.freeze(['coreutils', 'busybox', 'toybox']);

/** A program to compare, as the user wrote it. */
export interface ProgramCommand {
  /** A path, or a name looked up on the PATH. */
  executable: string;
  /** Arguments every case gets before its own (after the tool name, for a multicall binary). */
  args: string[];
  /** For a multicall binary: the tool to run. */
  tool?: string;
}

// A tool name: no path, not an option.
const TOOL_NAME = /^[^/\-.\s][^/\s]*$/;

/**
 * Reads a program command: `/usr/bin/sort`, `gsort`, `'coreutils sort'`, `'python3 tool.py'`. A
 * string is split on whitespace, with single or double quotes around words that contain spaces
 * (no escapes, no other shell syntax). A multicall binary followed by a plain name runs that tool.
 */
export function parseProgramCommand(command: string | readonly string[]): ProgramCommand {
  const words = typeof command === 'string' ? splitWords(command) : [...command];
  if (words.length === 0) throw new Error('The program command is empty.');
  const [executable, ...args] = words as [string, ...string[]];
  const first = args[0];
  if (MULTICALL_BINARIES.includes(basename(executable)) && first !== undefined && TOOL_NAME.test(first)) {
    return { executable, args: args.slice(1), tool: first };
  }
  return { executable, args };
}

function splitWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+)|(['"]))/gy;
  let current: string | undefined;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = pattern.exec(command)) !== null) {
    if (match[4] !== undefined) throw new Error(`Unclosed ${match[4]} quote in the program command: ${command}`);
    // Pieces with no whitespace between them form one word (`a'b c'` is "ab c").
    const glued = current !== undefined && match.index === last && !/^\s/.test(match[0]);
    const piece = match[1] ?? match[2] ?? match[3] ?? '';
    if (glued) current += piece;
    else {
      if (current !== undefined) words.push(current);
      current = piece;
    }
    last = pattern.lastIndex;
  }
  if (current !== undefined) words.push(current);
  return words;
}

/** A program found on disk. */
export interface ResolvedProgram extends ProgramCommand {
  /** Absolute path of the executable, as found (links not followed). */
  path: string;
  /** The same with every link followed: the file that runs. */
  realPath: string;
}

export interface ResolveProgramOptions {
  /** Where relative paths start. Defaults to the current directory. */
  cwd?: string;
  /** The PATH to search for a bare name. Defaults to this process's. */
  pathEnv?: string;
}

/**
 * Finds the executable of a program command. A link to a multicall binary (busybox installs
 * `/bin/sort -> busybox`) is that binary running the tool of the link's name.
 */
export async function resolveProgram(command: ProgramCommand, options: ResolveProgramOptions = {}): Promise<ResolvedProgram> {
  const cwd = options.cwd ?? process.cwd();
  let path: string;
  if (command.executable.includes('/')) {
    path = resolve(cwd, command.executable);
    await checkExecutable(path);
  } else {
    path = await searchPath(command.executable, options.pathEnv ?? process.env.PATH ?? '', cwd);
  }
  const realPath = await realpath(path);
  const program: ResolvedProgram = { ...command, path, realPath };
  const name = basename(path);
  if (command.tool === undefined && MULTICALL_BINARIES.includes(basename(realPath)) && !MULTICALL_BINARIES.includes(name)) {
    program.tool = name;
  }
  return program;
}

async function checkExecutable(path: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    throw new Error(`Program ${path} not found.`);
  }
  try {
    if (!isFile) throw new Error();
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`Program ${path} is not executable.`);
  }
}

async function searchPath(name: string, pathEnv: string, cwd: string): Promise<string> {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const candidate = resolve(cwd, dir, name);
    try {
      await checkExecutable(candidate);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  throw new Error(`Program ${name} not found on the PATH.`);
}

/**
 * The name both sides run as when none is configured: the tool of a multicall side (which can't
 * run under another name), else the reference's basename. `programs` starts with the reference.
 */
export function defaultProgramName(programs: readonly ResolvedProgram[]): string {
  const multicall = programs.find((p) => p.tool !== undefined);
  if (multicall) return multicall.tool!;
  if (programs.length === 0) throw new Error('No programs to name.');
  return basename(programs[0]!.path);
}

/** One side's program, set up to run under the pinned name. */
export interface PinnedProgram {
  /** Directory holding only the program, under the pinned name; goes first on the PATH. */
  binDir: string;
  /** Arguments every case gets before its own. */
  args: string[];
  /** What the sandbox must show for the program to run (see `SandboxCommandOptions.readOnlyPaths`). */
  readOnlyPaths: string[];
}

/**
 * Sets up every side to run as the same argv[0], since GNU tools print their own name from it
 * (`sort: invalid option`) and multicall binaries pick their tool by it. Each side gets a directory
 * under `dir` holding one entry named `name`: a link to the program, or for a multicall binary a
 * copy, because some (uutils) refuse to run a tool whose name differs from the file that runs.
 * Done once per run; every case of a side runs through `pinnedProcess`.
 */
export async function pinPrograms(
  dir: string,
  programs: readonly ResolvedProgram[],
  options: { name?: string } = {},
): Promise<{ name: string; sides: PinnedProgram[] }> {
  const name = options.name ?? defaultProgramName(programs);
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`The program name must be a plain file name, got "${name}".`);
  }
  for (const program of programs) {
    if (program.tool !== undefined && program.tool !== name) {
      throw new Error(
        `${program.path} is a multicall binary that runs only as "${program.tool}", but the program name is "${name}". Set the program name to "${program.tool}".`,
      );
    }
  }
  const root = resolve(dir);
  const sides: PinnedProgram[] = [];
  for (const [i, program] of programs.entries()) {
    const binDir = join(root, `side-${i}`);
    await mkdir(binDir, { recursive: true });
    const entry = join(binDir, name);
    await rm(entry, { force: true }); // left by an earlier pin into the same directory
    if (program.tool !== undefined) {
      await copyFile(program.realPath, entry);
      await chmod(entry, (await stat(program.realPath)).mode & 0o777);
      sides.push({ binDir, args: [...program.args], readOnlyPaths: [binDir] });
    } else {
      // Linked to the file itself: a link to a link would need every hop visible in the sandbox.
      await symlink(program.realPath, entry);
      sides.push({ binDir, args: [...program.args], readOnlyPaths: [binDir, program.realPath] });
    }
  }
  return { name, sides };
}

/**
 * The argv, environment and visible paths of one case for a pinned side: argv[0] is the bare
 * name, found first on the PATH, so the program sees exactly that name. The PATH (and `$0` in a
 * script) then contains the side's directory, which differs between sides; the `tmp-paths`
 * normalizer covers it.
 */
export function pinnedProcess(
  name: string,
  pinned: PinnedProgram,
  caseArgv: readonly string[],
  env: Readonly<Record<string, string>>,
): { argv: string[]; env: Record<string, string>; readOnlyPaths: string[] } {
  if (!isAbsolute(pinned.binDir)) throw new Error(`The pinned directory must be absolute, got "${pinned.binDir}".`);
  return {
    argv: [name, ...pinned.args, ...caseArgv],
    env: { ...env, PATH: env.PATH ? `${pinned.binDir}${delimiter}${env.PATH}` : pinned.binDir },
    readOnlyPaths: [...pinned.readOnlyPaths],
  };
}

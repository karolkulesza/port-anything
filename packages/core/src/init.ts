import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { CONFIG_FILE, ConfigError, parseConfig } from './config.js';
import { HISTORY_FILE, HISTORY_GITATTRIBUTES } from './history.js';
import { parseProgramCommand } from './program.js';

/** What `.gitignore` gets: the parts of `.port-anything/` that are rebuilt or per machine. */
export const GITIGNORED = ['.port-anything/cache/', '.port-anything/runs/', '.port-anything/probes/', '.port-anything/tmp/'] as const;

export interface InitOptions {
  /** The reference command, as typed; a relative executable path is taken from `cwd`. */
  reference?: string;
  /** Candidate commands, likewise. */
  candidates?: readonly string[];
  /** Where relative paths in the commands start; defaults to the current directory. */
  cwd?: string;
}

/** What `initProject` did to one file or directory, relative to the project directory. */
export interface InitStep {
  path: string;
  action: 'created' | 'updated' | 'unchanged';
  /** For `updated` and `created` text files: the lines it added. */
  added?: string[];
}

/**
 * Sets up a project directory (creating it if needed): writes `port-anything.yaml` for the given
 * reference and candidates, creates `.port-anything/`, adds the line that merges the parity
 * history by union to `.gitattributes` and the per-machine parts of `.port-anything/` to
 * `.gitignore`. Safe to run again: an existing config is kept (passing a reference or candidates
 * for it is then an error, so that nothing given is silently dropped) and lines already present
 * are not added twice. Throws a `ConfigError` for what it can't do.
 */
export async function initProject(dir: string, options: InitOptions = {}): Promise<InitStep[]> {
  const cwd = options.cwd ?? process.cwd();
  const projectDir = resolve(cwd, dir);
  const configFile = join(projectDir, CONFIG_FILE);
  const config = await newConfig(configFile, cwd, options); // before touching anything
  try {
    await mkdir(projectDir, { recursive: true });
  } catch (e) {
    throw new ConfigError(`Cannot create the project directory ${projectDir}: ${(e as Error).message}`);
  }
  if (config !== undefined) await write(configFile, stringify(config), 'wx');
  const steps: InitStep[] = [{ path: CONFIG_FILE, action: config === undefined ? 'unchanged' : 'created' }];

  const stateDir = join(projectDir, '.port-anything');
  const existed = await isDirectory(stateDir);
  try {
    await mkdir(stateDir, { recursive: true });
  } catch (e) {
    throw new ConfigError(`Cannot create ${stateDir}: ${(e as Error).message}`);
  }
  steps.push({ path: '.port-anything/', action: existed ? 'unchanged' : 'created' });

  steps.push(await ensureLines(projectDir, '.gitattributes', [HISTORY_GITATTRIBUTES], hasUnionMerge));
  steps.push(await ensureLines(projectDir, '.gitignore', GITIGNORED, (lines, wanted) => lines.includes(wanted)));
  return steps;
}

/** The config to write, or undefined to keep the one there. */
async function newConfig(file: string, cwd: string, { reference, candidates = [] }: InitOptions): Promise<object | undefined> {
  if (await exists(file)) {
    if (reference !== undefined || candidates.length > 0) {
      throw new ConfigError(`${file} already exists; edit it to change the reference or candidates, or run init without --ref and --candidate.`);
    }
    return undefined;
  }
  if (reference === undefined) throw new ConfigError(`No ${CONFIG_FILE} in ${dirname(file)} yet: give the reference with --ref <cmd>.`);
  const projectDir = dirname(file);
  const program = (cmd: string) => ({ cmd: rebase(cmd, cwd, projectDir) });
  const config = {
    version: 1,
    reference: program(reference),
    ...(candidates.length === 1 ? { candidate: program(candidates[0]!) } : candidates.length > 1 ? { candidates: candidates.map(program) } : {}),
    sandbox: { mode: 'local' },
  };
  parseConfig(config, CONFIG_FILE); // what it writes must load
  return config;
}

/**
 * A command as `port-anything.yaml` holds it: one plain word as a string, otherwise a list. A relative
 * executable path is rewritten to start at the project directory, where the config's paths start;
 * arguments are left as typed.
 */
function rebase(command: string, cwd: string, projectDir: string): string | string[] {
  let parsed;
  try {
    parsed = parseProgramCommand(command);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  let { executable } = parsed;
  if (executable.includes('/') && !isAbsolute(executable)) {
    const path = relative(projectDir, resolve(cwd, executable));
    executable = path === '..' || path.startsWith('../') ? path : `./${path}`;
  }
  const words = [executable, ...(parsed.tool === undefined ? [] : [parsed.tool]), ...parsed.args];
  // One word as a string only when it reads back as itself: no whitespace or quotes to split on.
  return words.length === 1 && !/[\s'"]/.test(words[0]!) ? words[0]! : words;
}

/** A `.gitattributes` line for the history path that sets `merge=union`. */
function hasUnionMerge(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    return (pattern === `.port-anything/${HISTORY_FILE}` || pattern === `/.port-anything/${HISTORY_FILE}`) && attributes.includes('merge=union');
  });
}

/** Adds the lines `has` doesn't find to a text file, keeping what is there. */
async function ensureLines(
  projectDir: string,
  name: string,
  wanted: readonly string[],
  has: (lines: readonly string[], wanted: string) => boolean,
): Promise<InitStep> {
  const file = join(projectDir, name);
  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`Cannot read ${file}: ${(e as Error).message}`);
  }
  const lines = (text ?? '').split(/\r?\n/);
  const added = wanted.filter((line) => !has(lines, line));
  if (added.length === 0) return { path: name, action: 'unchanged' };
  const before = text === undefined || text === '' || text.endsWith('\n') ? (text ?? '') : `${text}\n`;
  await write(file, `${before}${added.join('\n')}\n`);
  return { path: name, action: text === undefined ? 'created' : 'updated', added };
}

async function write(file: string, text: string, flag = 'w'): Promise<void> {
  try {
    await writeFile(file, text, { flag });
  } catch (e) {
    throw new ConfigError(`Cannot write ${file}: ${(e as Error).message}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

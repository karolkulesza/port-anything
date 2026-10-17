import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliResult } from './common.js';

export const USAGE = 'Usage: port-anything setup';

/** The MCP server every agent gets: the published CLI's `mcp`, which serves the project in the agent's working directory. */
export const MCP_SERVER = { name: 'port-anything', command: 'npx', args: ['-y', 'port-anything', 'mcp'] } as const;

/** Where to look for agents and write their settings: a home directory and the environment that may move an agent's own. */
export interface SetupEnvironment {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** What `setup` did for one agent's MCP server or skills. */
type Change = 'added' | 'updated' | 'already there' | 'there but running something else, left as it is';

/** An agent `setup` knows: how to tell it is installed and where its MCP servers and skills go. */
interface Agent {
  name: string;
  /** The directory whose presence says the agent is installed. */
  configDir(e: SetupEnvironment): string;
  /** Registers the MCP server; says what changed and in which file. */
  registerMcp(e: SetupEnvironment): Promise<{ file: string; change: Change }>;
  /** The directory skills go in, one `<name>/SKILL.md` each, given the names of all the agents found. */
  skillsDir(e: SetupEnvironment, found: readonly string[]): string;
}

// An agent's environment variable set but empty counts as unset.
const claudeDir = (e: SetupEnvironment) => e.env.CLAUDE_CONFIG_DIR || join(e.home, '.claude');
const codexDir = (e: SetupEnvironment) => e.env.CODEX_HOME || join(e.home, '.codex');
const geminiDir = (e: SetupEnvironment) => join(e.env.GEMINI_CLI_HOME || e.home, '.gemini');
/** The skills directory Codex, Gemini CLI and Cursor all read (Codex's own, ~/.codex/skills, is deprecated). */
const sharedSkills = (e: SetupEnvironment) => join(e.home, '.agents', 'skills');
const ENTRY = { command: MCP_SERVER.command, args: [...MCP_SERVER.args] };

export const AGENTS: readonly Agent[] = [
  {
    name: 'Claude Code',
    configDir: claudeDir,
    // User-scope servers live in ~/.claude.json, beside the config directory (inside it when CLAUDE_CONFIG_DIR moves it).
    registerMcp: (e) => mergeJsonServer(e.env.CLAUDE_CONFIG_DIR ? join(e.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(e.home, '.claude.json'), { type: 'stdio', ...ENTRY, env: {} }),
    // Claude Code reads no other agent's directory.
    skillsDir: (e) => join(claudeDir(e), 'skills'),
  },
  {
    name: 'Codex',
    configDir: codexDir,
    registerMcp: (e) => mergeTomlServer(join(codexDir(e), 'config.toml')),
    skillsDir: sharedSkills,
  },
  {
    name: 'Cursor',
    configDir: (e) => join(e.home, '.cursor'),
    registerMcp: (e) => mergeJsonServer(join(e.home, '.cursor', 'mcp.json'), { type: 'stdio', ...ENTRY }),
    // Cursor also reads ~/.claude/skills: with Claude Code set up too, a second copy would list each skill twice.
    skillsDir: (e, others) => (others.includes('Claude Code') ? join(claudeDir(e), 'skills') : sharedSkills(e)),
  },
  {
    name: 'Gemini CLI',
    configDir: geminiDir,
    registerMcp: (e) => mergeJsonServer(join(geminiDir(e), 'settings.json'), ENTRY),
    // Gemini CLI reads ~/.agents/skills as its user skills directory too.
    skillsDir: sharedSkills,
  },
];

/**
 * `port-anything setup`: for each agent installed for this user (Claude Code, Codex, Cursor,
 * Gemini CLI), registers the MCP server and installs the skills, and lists what it did. Run again,
 * it changes only what differs. Exit 0; 3 for unexpected arguments, no agent found, or a settings
 * file it can't read or safely add the server to (after setting up everything else).
 */
export async function setupCommand(argv: readonly string[], options: { environment?: SetupEnvironment; skillsSource?: string } = {}): Promise<CliResult> {
  if (argv.length > 0) return { exitCode: 3, stdout: '', stderr: `port-anything setup: unexpected argument "${argv[0]}"; it takes none.\n${USAGE}\n` };
  const e = options.environment ?? { home: homedir(), env: process.env };
  const source = options.skillsSource ?? bundledSkills();
  const found = AGENTS.filter((a) => existsSync(a.configDir(e)));
  if (found.length === 0) {
    return { exitCode: 3, stdout: '', stderr: `port-anything setup: found none of ${AGENTS.map((a) => a.name).join(', ')} (looked for ${AGENTS.map((a) => a.configDir(e)).join(', ')}).\n` };
  }
  const names = found.map((a) => a.name);
  const lines: string[] = [];
  // Agents may share a skills directory; each is written once, and each agent lists what happened to it.
  const installed = new Map<string, Map<string, Change>>();
  // A settings file one agent's server can't be added to doesn't stop the others.
  const errors: string[] = [];
  for (const agent of found) {
    let mcp: string;
    try {
      const done = await agent.registerMcp(e);
      mcp = `MCP server ${MCP_SERVER.name} in ${done.file}: ${done.change}`;
    } catch (err) {
      if (!(err instanceof SetupError)) throw err;
      errors.push(err.message);
      mcp = `MCP server ${MCP_SERVER.name} not added: ${err.message}`;
    }
    const dir = agent.skillsDir(e, names);
    if (!installed.has(dir)) installed.set(dir, await installSkills(source, dir));
    lines.push(`${agent.name}:`, `  ${mcp}`, `  skills in ${dir}: ${describeSkills(installed.get(dir)!)}`);
  }
  const missing = AGENTS.filter((a) => !found.includes(a)).map((a) => a.name);
  if (missing.length > 0) lines.push(`Not found: ${missing.join(', ')}.`);
  lines.push('Restart the agents to load the server and the skills. The server serves the Port Anything project in the directory the agent runs in.');
  return { exitCode: errors.length > 0 ? 3 : 0, stdout: `${lines.join('\n')}\n`, stderr: errors.map((m) => `port-anything setup: ${m}\n`).join('') };
}

class SetupError extends Error {}

/** The skills shipped in the package (`dist/skills`), or in the repo when running from source. */
function bundledSkills(): string {
  for (const url of [new URL('skills/', import.meta.url), new URL('../../../skills/', import.meta.url)]) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  throw new Error('The agent skills are missing from this installation of port-anything.');
}

/** A JSON settings file as an object; a missing or empty file is `{}`. */
async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SetupError(`${file} is not valid JSON (${(err as Error).message}); fix it or add the server by hand.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SetupError(`${file} doesn't hold a JSON object; fix it or add the server by hand.`);
  return parsed as Record<string, unknown>;
}

/** Writes a file through a temporary one beside it, so a reader never sees half of it. */
async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.port-anything-${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

/** Sets `mcpServers["port-anything"]` in a JSON settings file, keeping everything else in it. */
async function mergeJsonServer(file: string, entry: Record<string, unknown>): Promise<{ file: string; change: Change }> {
  const settings = await readJsonObject(file);
  const servers = settings.mcpServers ?? {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) throw new SetupError(`mcpServers in ${file} isn't an object; fix it or add the server by hand.`);
  const current = (servers as Record<string, unknown>)[MCP_SERVER.name];
  if (JSON.stringify(current) === JSON.stringify(entry)) return { file, change: 'already there' };
  settings.mcpServers = { ...(servers as Record<string, unknown>), [MCP_SERVER.name]: entry };
  await writeAtomically(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, change: current === undefined ? 'added' : 'updated' };
}

/** The TOML table for the server, as Codex reads it. */
const TOML_TABLE = `[mcp_servers.${MCP_SERVER.name}]\ncommand = ${JSON.stringify(MCP_SERVER.command)}\nargs = [${MCP_SERVER.args.map((a) => JSON.stringify(a)).join(', ')}]\n`;

/**
 * Adds the `[mcp_servers.port-anything]` table to a TOML config. Appending a table nobody defined
 * yet keeps the file valid without parsing it. A table that is already there is left alone, and
 * said so when it runs something else; a server defined any other way (an inline table under
 * `[mcp_servers]`, dotted keys) is a `SetupError`, since appending would define it twice and
 * rewriting it would mean parsing TOML.
 */
async function mergeTomlServer(file: string): Promise<{ file: string; change: Change }> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const existing = tomlServer(text);
  if (existing === 'table') return { file, change: 'already there' };
  if (existing === 'other table') return { file, change: 'there but running something else, left as it is' };
  if (existing !== undefined) {
    throw new SetupError(`${file} already defines mcp_servers.${MCP_SERVER.name} (${existing}); make it run "${[MCP_SERVER.command, ...MCP_SERVER.args].join(' ')}" by hand.`);
  }
  const separator = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  await writeAtomically(file, `${text}${separator}${TOML_TABLE}`);
  return { file, change: 'added' };
}

/**
 * How a TOML text defines the server: `table` for the table `setup` writes (other settings of the
 * user's in it are fine), `other table` for that table with another command or arguments, a
 * description for any other definition, undefined for none. Reads lines, not TOML: enough for the forms a
 * config file uses (tables, inline tables, dotted keys), and on the safe side for the rest.
 */
function tomlServer(text: string): 'table' | string | undefined {
  const name = `(?:${MCP_SERVER.name}|"${MCP_SERVER.name}"|'${MCP_SERVER.name}')`;
  const ours = new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*${name}\\s*\\]$`);
  const sub = new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*${name}\\s*\\.`);
  const dotted = new RegExp(`^mcp_servers\\s*\\.\\s*${name}\\s*[.=]`);
  const key = new RegExp(`^${name}\\s*[.=]`);
  const lines = text.split('\n').map((l) => l.trim());
  let table: string | undefined;
  let body: string[] | undefined;
  let subTable: string | undefined;
  for (const line of lines) {
    if (line.startsWith('[')) {
      table = tableHeader(line);
      if (ours.test(table)) {
        if (body !== undefined) return 'a second table';
        body = [];
      } else if (sub.test(table)) subTable ??= table;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (table === undefined && dotted.test(line)) return 'dotted keys';
    if (table === undefined && /^mcp_servers\s*=/.test(line) && line.includes(MCP_SERVER.name)) return 'an inline mcp_servers table';
    if (table !== undefined && /^\[\s*mcp_servers\s*\]$/.test(table) && key.test(line)) return 'a key under [mcp_servers]';
    if (table !== undefined && ours.test(table)) body!.push(line.replace(/\s+#[^"']*$/, '').replace(/\s*=\s*/, ' = '));
  }
  // Its sub-table alone (`[mcp_servers.port-anything.env]`): the table is defined, by a form not to add to.
  if (body === undefined) return subTable === undefined ? undefined : `a ${subTable} table`;
  const expected = TOML_TABLE.trim().split('\n').slice(1);
  return expected.every((l) => body.includes(l)) ? 'table' : 'other table';
}

/** A table header line (`[a.b]`, `[[a.b]]`) without what follows it: up to its first `]` outside quotes, so a comment after it, `]` and all, goes. */
function tableHeader(line: string): string {
  const close = line.startsWith('[[') ? ']]' : ']';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (line.startsWith(close, i)) return line.slice(0, i + close.length);
  }
  return line;
}

/** Copies each skill directory of `source` into `target`, replacing an older copy; what changed per skill. */
async function installSkills(source: string, target: string): Promise<Map<string, Change>> {
  const changes = new Map<string, Change>();
  for (const name of (await readdir(source)).sort()) {
    const from = join(source, name);
    if (!(await stat(from)).isDirectory() || !existsSync(join(from, 'SKILL.md'))) continue;
    const to = join(target, name);
    const before = existsSync(to) ? await snapshot(to) : undefined;
    if (before !== undefined && before === (await snapshot(from))) {
      changes.set(name, 'already there');
      continue;
    }
    await rm(to, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(from, to, { recursive: true });
    changes.set(name, before === undefined ? 'added' : 'updated');
  }
  return changes;
}

/** A directory's files and their contents, as one string to compare. */
async function snapshot(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).sort();
  const parts = await Promise.all(files.map(async (f) => `${f.slice(dir.length)}\0${await readFile(f, 'latin1')}`));
  return parts.join('\0\0');
}

function describeSkills(changes: Map<string, Change>): string {
  const by = (change: Change) => [...changes].filter(([, c]) => c === change).map(([name]) => name);
  return (['added', 'updated', 'already there'] as const)
    .filter((c) => by(c).length > 0)
    .map((c) => `${by(c).join(', ')} ${c}`)
    .join('; ');
}

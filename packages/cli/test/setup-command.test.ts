import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { setupCommand } from '../src/setup-command.js';

// Each test gets its own home directory, with only the agents it creates installed.
let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-setup-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const SKILLS = ['port-audit', 'port-loop', 'port-plan', 'port-report'];
const repoSkill = (name: string) => readFileSync(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
const setup = (env: Record<string, string> = {}) => setupCommand([], { environment: { home, env } });
const json = (path: string) => JSON.parse(readFileSync(join(home, path), 'utf8')) as Record<string, unknown>;
const install = (...dirs: string[]) => dirs.forEach((d) => mkdirSync(join(home, d), { recursive: true }));

function expectSkills(dir: string) {
  for (const name of SKILLS) expect(readFileSync(join(home, dir, name, 'SKILL.md'), 'utf8'), `${dir}/${name}`).toBe(repoSkill(name));
}

describe('port-anything setup', () => {
  it('registers the MCP server and the skills for Claude Code, keeping the rest of its settings', async () => {
    install('.claude');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'other' } } }));
    const result = await setup();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(json('.claude.json')).toEqual({
      numStartups: 3,
      mcpServers: { other: { type: 'stdio', command: 'other' }, 'port-anything': { type: 'stdio', command: 'npx', args: ['-y', 'port-anything', 'mcp'], env: {} } },
    });
    expectSkills('.claude/skills');
    expect(result.stdout).toContain(`Claude Code:\n  MCP server port-anything in ${join(home, '.claude.json')}: added\n  skills in ${join(home, '.claude/skills')}: port-audit, port-loop, port-plan, port-report added\n`);
    expect(result.stdout).toContain('Not found: Codex, Cursor, Gemini CLI.');
  });

  it('registers the MCP server and the skills for Codex in its TOML config', async () => {
    install('.codex');
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n');
    expect((await setup()).exitCode).toBe(0);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.port-anything]\ncommand = "npx"\nargs = ["-y", "port-anything", "mcp"]\n');
    expectSkills('.agents/skills');
  });

  it('registers the MCP server and the skills for Cursor', async () => {
    install('.cursor');
    expect((await setup()).exitCode).toBe(0);
    expect(json('.cursor/mcp.json')).toEqual({ mcpServers: { 'port-anything': { type: 'stdio', command: 'npx', args: ['-y', 'port-anything', 'mcp'] } } });
    expectSkills('.agents/skills');
  });

  it('registers the MCP server and the skills for Gemini CLI, keeping the rest of its settings', async () => {
    install('.gemini');
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dracula' }));
    expect((await setup()).exitCode).toBe(0);
    expect(json('.gemini/settings.json')).toEqual({ theme: 'Dracula', mcpServers: { 'port-anything': { command: 'npx', args: ['-y', 'port-anything', 'mcp'] } } });
    expectSkills('.agents/skills');
  });

  it('sets up every agent it finds, and leaves alone those it does not', async () => {
    install('.claude', '.codex', '.cursor', '.gemini');
    const result = await setup();
    expect(result.exitCode).toBe(0);
    for (const name of ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI']) expect(result.stdout).toContain(`${name}:\n`);
    expect(result.stdout).not.toContain('Not found');
    // Two copies of the skills cover all four: Codex and Gemini CLI share one, Cursor reads Claude Code's.
    expectSkills('.claude/skills');
    expectSkills('.agents/skills');
    expect(result.stdout).toContain(`Cursor:\n  MCP server port-anything in ${join(home, '.cursor/mcp.json')}: added\n  skills in ${join(home, '.claude/skills')}: port-audit, port-loop, port-plan, port-report added\n`);
    expect(result.stdout).toContain(`Gemini CLI:\n  MCP server port-anything in ${join(home, '.gemini/settings.json')}: added\n  skills in ${join(home, '.agents/skills')}: port-audit, port-loop, port-plan, port-report added\n`);
    for (const path of ['.cursor/skills', '.gemini/skills', '.codex/skills']) expect(existsSync(join(home, path)), path).toBe(false);

    rmSync(home, { recursive: true });
    mkdirSync(home);
    install('.gemini');
    await setup();
    expectSkills('.agents/skills');
    for (const path of ['.claude.json', '.claude/skills', '.codex/config.toml', '.cursor/mcp.json']) expect(existsSync(join(home, path)), path).toBe(false);
  });

  it('follows CLAUDE_CONFIG_DIR, CODEX_HOME and GEMINI_CLI_HOME', async () => {
    install('claude-config', 'codex-home', 'gemini-home/.gemini');
    const env = { CLAUDE_CONFIG_DIR: join(home, 'claude-config'), CODEX_HOME: join(home, 'codex-home'), GEMINI_CLI_HOME: join(home, 'gemini-home') };
    expect((await setup(env)).exitCode).toBe(0);
    expect(json('claude-config/.claude.json')).toHaveProperty(['mcpServers', 'port-anything']);
    expectSkills('claude-config/skills');
    expect(readFileSync(join(home, 'codex-home', 'config.toml'), 'utf8')).toContain('[mcp_servers.port-anything]');
    expect(json('gemini-home/.gemini/settings.json')).toHaveProperty(['mcpServers', 'port-anything']);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

  it('changes nothing the second time, and brings an outdated server entry or skill up to date', async () => {
    install('.claude', '.codex');
    await setup();
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    const again = await setup();
    expect(again.stdout).toContain('MCP server port-anything in');
    expect(again.stdout).not.toMatch(/: (added|updated)\n/);
    expect(again.stdout).toContain('port-audit, port-loop, port-plan, port-report already there');
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(toml);

    const settings = json('.claude.json') as { mcpServers: Record<string, unknown> };
    settings.mcpServers['port-anything'] = { type: 'stdio', command: 'port-anything', args: ['mcp'] };
    writeFileSync(join(home, '.claude.json'), JSON.stringify(settings));
    writeFileSync(join(home, '.claude', 'skills', 'port-loop', 'SKILL.md'), 'old');
    writeFileSync(join(home, '.claude', 'skills', 'port-loop', 'stale.md'), 'old');
    const updated = await setup();
    expect(updated.stdout).toContain(`MCP server port-anything in ${join(home, '.claude.json')}: updated`);
    expect(updated.stdout).toContain('port-loop updated; port-audit, port-plan, port-report already there');
    expect(json('.claude.json')).toHaveProperty(['mcpServers', 'port-anything', 'command'], 'npx');
    expectSkills('.claude/skills');
    expect(existsSync(join(home, '.claude', 'skills', 'port-loop', 'stale.md'))).toBe(false);
  });

  it('leaves a Codex server defined some other way alone and says so, rather than defining it twice', async () => {
    install('.codex');
    const configs = [
      '[mcp_servers]\nport-anything = { command = "npx", args = ["-y", "port-anything", "mcp"] }\n',
      'mcp_servers.port-anything.command = "npx"\n',
      'mcp_servers = { port-anything = { command = "npx" } }\n',
      '[mcp_servers."port-anything".env]\nTZ = "UTC"\n',
    ];
    for (const config of configs) {
      writeFileSync(join(home, '.codex', 'config.toml'), config);
      const result = await setup();
      expect({ config, exitCode: result.exitCode }).toEqual({ config, exitCode: 3 });
      expect(result.stderr).toMatch(/config\.toml already defines mcp_servers\.port-anything \(.+\); make it run "npx -y port-anything mcp" by hand/);
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(config);
    }
    // Its own table running something else is the user's choice: said, left alone, and not an error.
    const other = '[mcp_servers.port-anything]\ncommand = "port-anything"\nargs = ["mcp"]\n';
    writeFileSync(join(home, '.codex', 'config.toml'), other);
    const differs = await setup();
    expect(differs.exitCode).toBe(0);
    expect(differs.stdout).toMatch(/config\.toml: there but running something else, left as it is/);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(other);
    // The table setup writes, with a comment after its header, other spacing and settings of the user's, is the same server.
    const same = '[mcp_servers.port-anything]# for ports\ncommand="npx"\nstartup_timeout_sec = 30\nargs = ["-y", "port-anything", "mcp"] # pinned later\n\n[mcp_servers.port-anything.env]\nTZ = "UTC"\n\n[other]\nx = 1\n';
    writeFileSync(join(home, '.codex', 'config.toml'), same);
    const result = await setup();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/MCP server port-anything in .*config\.toml: already there/);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(same);
  });

  it('sets up the other agents when one settings file refuses the server, then exits 3', async () => {
    install('.claude', '.codex', '.gemini');
    const config = '[mcp_servers]\nport-anything = { command = "npx" }\n';
    writeFileSync(join(home, '.codex', 'config.toml'), config);
    const result = await setup();
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/^port-anything setup: .*config\.toml already defines mcp_servers\.port-anything \(a key under \[mcp_servers\]\)/);
    expect(result.stdout).toMatch(/Codex:\n {2}MCP server port-anything not added: .*config\.toml already defines/);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(config);
    expect(json('.gemini/settings.json')).toHaveProperty(['mcpServers', 'port-anything', 'command'], 'npx');
    expectSkills('.agents/skills');
    expectSkills('.claude/skills');
  });

  it('refuses a settings file it cannot parse, without touching it', async () => {
    install('.cursor');
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ "mcpServers": ');
    const result = await setup();
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/^port-anything setup: .*\.cursor\/mcp\.json is not valid JSON/);
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{ "mcpServers": ');
  });

  it('exits 3 when it finds no agent, and takes no arguments', async () => {
    const none = await setup();
    expect(none.exitCode).toBe(3);
    expect(none.stderr).toMatch(/^port-anything setup: found none of Claude Code, Codex, Cursor, Gemini CLI/);
    expect(await run(['setup', '--force'])).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringContaining('Usage: port-anything setup\n') });
  });
});

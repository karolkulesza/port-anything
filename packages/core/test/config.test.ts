import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, ConfigError, configCandidates, parseConfig, readConfigFile } from '../src/config.js';

describe('parseConfig', () => {
  it('fills in the defaults of a minimal config', () => {
    const config = parseConfig({ version: 1, reference: { cmd: './ref/tool' } });
    expect(config).toEqual({
      version: 1,
      reference: { cmd: './ref/tool' },
      sandbox: { mode: 'local', timeout: 10_000, env_allowlist: [], env: {} },
    });
    expect(configCandidates(config)).toEqual([]);
  });

  it('reads the keys of the documented example', () => {
    const config = parseConfig({
      version: 1,
      program_name: 'tool',
      reference: { cmd: ['./ref/bin/tool'], build: 'make -C ref' },
      candidate: { cmd: ['./port/target/release/tool'], build: 'cargo build --release' },
      sandbox: { mode: 'container', image: 'debian:12-slim', timeout: '10s', env_allowlist: ['COLUMNS', 'NO_COLOR'], env: { TZ: 'UTC', LANG: 'C.UTF-8' } },
      compare: { profile: 'standard' },
      normalizers: ['tmp-paths'],
      corpus: { repeats: 3 },
      holdout: { fresh_cases: 1000 },
      report: { title: 'tool → Rust' },
    });
    expect(config.program_name).toBe('tool');
    expect(config.sandbox).toEqual({ mode: 'container', image: 'debian:12-slim', timeout: 10_000, env_allowlist: ['COLUMNS', 'NO_COLOR'], env: { TZ: 'UTC', LANG: 'C.UTF-8' } });
    expect(configCandidates(config)).toEqual([{ cmd: ['./port/target/release/tool'], build: 'cargo build --release' }]);
  });

  it('takes several candidates, but not both spellings at once', () => {
    const config = parseConfig({ version: 1, reference: { cmd: 'gnusort' }, candidates: [{ cmd: 'coreutils sort' }, { cmd: 'busybox sort' }] });
    expect(configCandidates(config).map((c) => c.cmd)).toEqual(['coreutils sort', 'busybox sort']);
    expect(() => parseConfig({ version: 1, reference: { cmd: 'a' }, candidate: { cmd: 'b' }, candidates: [{ cmd: 'c' }] })).toThrow(
      /candidates: use either candidate or candidates/,
    );
  });

  it('reads timeouts in ms, s, m or plain seconds', () => {
    const timeout = (value: unknown) => parseConfig({ version: 1, reference: { cmd: 'a' }, sandbox: { timeout: value } }).sandbox.timeout;
    expect(timeout('500ms')).toBe(500);
    expect(timeout('2.5s')).toBe(2500);
    expect(timeout('2m')).toBe(120_000);
    expect(timeout(3)).toBe(3000);
    expect(() => timeout('10 seconds')).toThrow(/sandbox.timeout: must be a positive duration/);
    expect(() => timeout(0)).toThrow(ConfigError);
    expect(timeout('35791m')).toBe(35_791 * 60_000);
    expect(() => timeout('100000m')).toThrow(/sandbox\.timeout: must be at most/);
    expect(() => timeout(2 ** 31)).toThrow(/sandbox\.timeout: must be at most/);
  });

  it('lists every problem by key, typos included', () => {
    let error: unknown;
    try {
      parseConfig({ version: 2, refrence: { cmd: 'a' }, sandbox: { env: { 'A=B': 'x' } } }, 'my.yaml');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toMatch(/^my\.yaml is not valid:/);
    expect(message).toMatch(/version: /);
    expect(message).toMatch(/reference: /);
    expect(message).toMatch(/refrence/);
    expect(message).toMatch(/sandbox\.env\.A=B: /);
  });

  it('takes only a plain file name as program_name', () => {
    expect(parseConfig({ version: 1, program_name: 'sort', reference: { cmd: 'a' } }).program_name).toBe('sort');
    for (const name of ['', '.', '..', 'a/b', '../../x', 'a\0b']) {
      expect(() => parseConfig({ version: 1, program_name: name, reference: { cmd: 'a' } })).toThrow(/program_name: /);
    }
  });

  it('refuses an empty command', () => {
    expect(() => parseConfig({ version: 1, reference: { cmd: '' } })).toThrow(/reference\.cmd/);
    expect(() => parseConfig({ version: 1, reference: { cmd: [] } })).toThrow(/reference\.cmd/);
  });
});

describe('readConfigFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads port-anything.yaml from the project directory', async () => {
    writeFileSync(
      join(dir, CONFIG_FILE),
      [
        '# comments are fine',
        'version: 1',
        'program_name: tool',
        'reference:',
        '  cmd: ["./ref/bin/tool"]',
        'candidates:',
        '  - cmd: ./port/tool',
        "  - cmd: 'coreutils sort'",
        'sandbox:',
        '  timeout: 2s',
        '  env: { TZ: UTC }',
        'normalizers:',
        '  - { float-tolerance: { rtol: 1e-9 }, scope: stdout }',
        '',
      ].join('\n'),
    );
    const config = await readConfigFile(dir);
    expect(config.program_name).toBe('tool');
    expect(config.reference.cmd).toEqual(['./ref/bin/tool']);
    expect(configCandidates(config).map((c) => c.cmd)).toEqual(['./port/tool', 'coreutils sort']);
    expect(config.sandbox).toMatchObject({ timeout: 2000, env: { TZ: 'UTC' } });
  });

  it('says when the file is missing, is not YAML, or has a duplicate key (ConfigError)', async () => {
    await expect(readConfigFile(dir)).rejects.toThrow(/No port-anything\.yaml in /);
    writeFileSync(join(dir, CONFIG_FILE), 'version: 1\nreference: [unclosed\n');
    await expect(readConfigFile(dir)).rejects.toThrow(ConfigError);
    await expect(readConfigFile(dir)).rejects.toThrow(/port-anything\.yaml is not valid YAML/);
    writeFileSync(join(dir, CONFIG_FILE), 'version: 1\nversion: 1\nreference: { cmd: a }\n');
    await expect(readConfigFile(dir)).rejects.toThrow(/not valid YAML/);
  });

  it('validates the content like parseConfig, naming the file', async () => {
    writeFileSync(join(dir, CONFIG_FILE), '');
    await expect(readConfigFile(dir)).rejects.toThrow(/port-anything\.yaml is not valid:\n {2}\(top level\)/);
    writeFileSync(join(dir, CONFIG_FILE), 'version: 1\nreference: { cmd: a }\nsandbox: { timeout: soon }\n');
    await expect(readConfigFile(dir)).rejects.toThrow(/sandbox\.timeout: must be a positive duration/);
  });
});

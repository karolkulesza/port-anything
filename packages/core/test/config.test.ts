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
      compare: { profile: 'standard', fields: { stderr: { similarity: 0.6 } } },
      normalizers: [],
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
      compare: { profile: 'standard', fields: { stderr: { mode: 'loose', similarity: 0.6 } }, max_slowdown: '2x', min_parity: 0.95 },
      normalizers: ['tmp-paths'],
      corpus: { repeats: 5, generator: 'v1', budget: 10000 },
      holdout: { fresh_cases: 1000 },
      report: { title: 'tool → Rust' },
    });
    expect(config.program_name).toBe('tool');
    expect(config.compare).toEqual({ profile: 'standard', fields: { stderr: { mode: 'loose', similarity: 0.6 } }, max_slowdown: 2, min_parity: 0.95 });
    expect(config.corpus?.repeats).toBe(5);
    expect(config.sandbox).toEqual({ mode: 'container', image: 'debian:12-slim', timeout: 10_000, env_allowlist: ['COLUMNS', 'NO_COLOR'], env: { TZ: 'UTC', LANG: 'C.UTF-8' } });
    expect(configCandidates(config)).toEqual([{ cmd: ['./port/target/release/tool'], build: 'cargo build --release' }]);
  });

  it('reads the strictness profile and the stderr mode, and refuses others', () => {
    const base = { version: 1, reference: { cmd: 'a' } };
    expect(parseConfig({ ...base, compare: { profile: 'lenient' } }).compare).toEqual({ profile: 'lenient', fields: { stderr: { similarity: 0.6 } } });
    expect(parseConfig({ ...base, compare: { profile: 'strict', fields: { stderr: { mode: 'exact' } } } }).compare.fields.stderr).toEqual({ mode: 'exact', similarity: 0.6 });
    expect(parseConfig({ ...base, compare: { fields: { stderr: { similarity: 0.8 } } } }).compare).toEqual({ profile: 'standard', fields: { stderr: { similarity: 0.8 } } });
    expect(() => parseConfig({ ...base, compare: { profile: 'paranoid' } })).toThrow(/compare\.profile: /);
    expect(() => parseConfig({ ...base, compare: { fields: { stderr: { mode: 'fuzzy' } } } })).toThrow(/compare\.fields\.stderr\.mode: /);
    expect(() => parseConfig({ ...base, compare: { fields: { stderr: { similarity: 1.5 } } } })).toThrow(/compare\.fields\.stderr\.similarity: /);
    expect(() => parseConfig({ ...base, compare: { fields: { stdout: { mode: 'loose' } } } })).toThrow(/compare\.fields: /);
    expect(() => parseConfig({ ...base, compare: { profiel: 'strict' } })).toThrow(/compare: /);
  });

  it('reads corpus.min_cases_per_feature, leaving the other corpus keys to later commands', () => {
    const base = { version: 1, reference: { cmd: 'a' } };
    expect(parseConfig({ ...base, corpus: { min_cases_per_feature: 5, repeats: 3, generator: 'v1' } }).corpus).toEqual({ min_cases_per_feature: 5, repeats: 3, generator: 'v1' });
    expect(parseConfig(base).corpus).toBeUndefined();
    expect(() => parseConfig({ ...base, corpus: { min_cases_per_feature: 0 } })).toThrow(/corpus\.min_cases_per_feature: /);
    expect(() => parseConfig({ ...base, corpus: { min_cases_per_feature: 2.5 } })).toThrow(/corpus\.min_cases_per_feature: /);
  });

  it('reads the generated corpus settings: a known generator, a whole seed and budget, an error-path cap between 0 and 1', () => {
    const base = { version: 1, reference: { cmd: 'a' } };
    const corpus = { generator: 'v1', generator_seed: 42, budget: 500, error_path_cap: 0.25, fresh: 'later' };
    expect(parseConfig({ ...base, corpus }).corpus).toEqual(corpus);
    expect(() => parseConfig({ ...base, corpus: { generator: 'v9' } })).toThrow(/corpus\.generator: /);
    expect(() => parseConfig({ ...base, corpus: { generator_seed: -1 } })).toThrow(/corpus\.generator_seed: /);
    expect(() => parseConfig({ ...base, corpus: { generator_seed: '42' } })).toThrow(/corpus\.generator_seed: /);
    expect(() => parseConfig({ ...base, corpus: { budget: 0 } })).toThrow(/corpus\.budget: /);
    expect(() => parseConfig({ ...base, corpus: { budget: 1.5 } })).toThrow(/corpus\.budget: /);
    expect(() => parseConfig({ ...base, corpus: { error_path_cap: 1.5 } })).toThrow(/corpus\.error_path_cap: /);
  });

  it('takes several candidates, but not both spellings at once', () => {
    const config = parseConfig({ version: 1, reference: { cmd: 'gnusort' }, candidates: [{ cmd: 'coreutils sort' }, { cmd: 'busybox sort' }] });
    expect(configCandidates(config).map((c) => c.cmd)).toEqual(['coreutils sort', 'busybox sort']);
    expect(() => parseConfig({ version: 1, reference: { cmd: 'a' }, candidate: { cmd: 'b' }, candidates: [{ cmd: 'c' }] })).toThrow(
      /candidates: use either candidate or candidates/,
    );
  });

  it('reads compare.max_slowdown as a factor, written 2x or as a plain number', () => {
    const max = (value: unknown) => parseConfig({ version: 1, reference: { cmd: 'a' }, compare: { max_slowdown: value } }).compare.max_slowdown;
    expect(max('2x')).toBe(2);
    expect(max('1.5x')).toBe(1.5);
    expect(max(3)).toBe(3);
    expect(max('1x')).toBe(1);
    expect(parseConfig({ version: 1, reference: { cmd: 'a' } }).compare.max_slowdown).toBeUndefined();
    for (const bad of ['2', '2 x', 'x', '0.5x', 0, -1, '200%']) {
      expect(() => max(bad)).toThrow(/compare\.max_slowdown: must be a factor of at least 1/);
    }
    expect(() => max(Infinity)).toThrow(/compare\.max_slowdown: /);
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

  it('takes at least 2 corpus repeats', () => {
    expect(() => parseConfig({ version: 1, reference: { cmd: 'a' }, corpus: { repeats: 1 } })).toThrow(/corpus\.repeats/);
    expect(() => parseConfig({ version: 1, reference: { cmd: 'a' }, corpus: { repeats: 2.5 } })).toThrow(/corpus\.repeats/);
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
    expect(config.normalizers).toEqual([{ name: 'float-tolerance', options: { rtol: 1e-9, atol: 0 }, scope: ['stdout'] }]);
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
    writeFileSync(join(dir, CONFIG_FILE), 'version: 1\nreference: { cmd: a }\nnormalizers: [tmp-paths, pid]\n');
    await expect(readConfigFile(dir)).rejects.toThrow(/normalizers\.1: unknown normalizer "pid"/);
  });
});

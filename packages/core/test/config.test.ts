import { describe, expect, it } from 'vitest';
import { ConfigError, configCandidates, parseConfig } from '../src/config.js';

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

  it('refuses an empty command', () => {
    expect(() => parseConfig({ version: 1, reference: { cmd: '' } })).toThrow(/reference\.cmd/);
    expect(() => parseConfig({ version: 1, reference: { cmd: [] } })).toThrow(/reference\.cmd/);
  });
});

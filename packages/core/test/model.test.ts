import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json.js';
import {
  type CaseInput,
  canonicalCase,
  canonicalCaseJson,
  canonicalObservation,
  canonicalObservationJson,
  caseId,
} from '../src/model.js';

const blob = (c: string) => `blob:sha256:${c.repeat(64)}`;

const base: CaseInput = {
  argv: ['--json', '-n', '3', 'input.csv'],
  stdin: blob('a'),
  env: { COLUMNS: '80', LANG: 'C' },
  fixtures: { 'input.csv': blob('b'), 'dir/more.csv': blob('c') },
  features: ['fmt.json', 'opt.n'],
  origin: 'generated',
};

describe('canonicalJson', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it('sorts by UTF-16 code units, as RFC 8785 does', () => {
    expect(canonicalJson({ é: 1, z: 2, Z: 3, '😀': 4, '｡': 5 })).toBe('{"Z":3,"z":2,"é":1,"😀":4,"｡":5}');
  });

  it('rejects values JSON cannot represent one way', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined at \$\.a/);
    expect(() => canonicalJson([Number.NaN])).toThrow(/NaN/);
    expect(() => canonicalJson(new Date(0))).toThrow(/object/);
  });
});

describe('case canonical form', () => {
  it('does not depend on key order or feature order', () => {
    const reordered: CaseInput = {
      origin: 'generated',
      features: ['opt.n', 'fmt.json', 'opt.n'],
      fixtures: { 'dir/more.csv': blob('c'), 'input.csv': blob('b') },
      env: { LANG: 'C', COLUMNS: '80' },
      stdin: blob('a'),
      argv: ['--json', '-n', '3', 'input.csv'],
    };
    expect(canonicalCaseJson(reordered)).toBe(canonicalCaseJson(base));
    expect(canonicalCase(reordered).features).toEqual(['fmt.json', 'opt.n']);
  });

  it('fills in defaults, so omitted and empty fields are the same case', () => {
    const minimal = canonicalCase({ argv: ['-l'], origin: 'recorded' });
    expect(minimal).toMatchObject({ stdin: null, env: {}, fixtures: {}, features: [] });
    expect(caseId({ argv: ['-l'], stdin: null, env: {}, fixtures: {}, features: [], origin: 'recorded' })).toBe(minimal.id);
  });

  it('keeps argv order: it is part of the invocation', () => {
    expect(caseId({ ...base, argv: ['-n', '3', '--json', 'input.csv'] })).not.toBe(caseId(base));
  });

  it('writes keys sorted at every level', () => {
    const json = canonicalCaseJson({ origin: 'imported', fixtures: { z: blob('b'), 'a/b': blob('c') }, env: { B: '1', A: '2' }, argv: ['x'] });
    const id = caseId({ argv: ['x'], env: { A: '2', B: '1' }, fixtures: { 'a/b': blob('c'), z: blob('b') }, origin: 'imported' });
    expect(json).toBe(
      `{"argv":["x"],"env":{"A":"2","B":"1"},"features":[],"fixtures":{"a/b":"${blob('c')}","z":"${blob('b')}"},` +
        `"id":"${id}","origin":"imported","stdin":null}`,
    );
  });
});

describe('case ID', () => {
  it('is the full SHA-256 of the canonical invocation', () => {
    const id = caseId(base);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    const invocation = canonicalJson({ argv: base.argv, stdin: base.stdin, env: base.env, fixtures: base.fixtures });
    expect(id).toBe(`sha256:${createHash('sha256').update(invocation).digest('hex')}`);
  });

  it('is the same for the same case, however often it is computed or recorded', () => {
    const copy = structuredClone(base);
    expect(caseId(copy)).toBe(caseId(base));
    expect(canonicalCase(canonicalCase(base)).id).toBe(caseId(base));
  });

  it('ignores metadata: features and origin do not change the invocation', () => {
    expect(caseId({ ...base, origin: 'imported', features: [] })).toBe(caseId(base));
  });

  it('changes with any part of the invocation', () => {
    const id = caseId(base);
    for (const variant of [
      { argv: [...(base.argv ?? []), ''] },
      { stdin: null },
      { stdin: blob('d') },
      { env: { ...base.env, LANG: 'C.UTF-8' } },
      { env: { COLUMNS: '80' } },
      { fixtures: { 'input.csv': blob('b') } },
      { fixtures: { 'input.csv': blob('b'), 'dir/other.csv': blob('c') } },
    ]) {
      expect(caseId({ ...base, ...variant })).not.toBe(id);
    }
  });

  it('tells "no stdin" (/dev/null) apart from an empty stdin blob', () => {
    const empty = `blob:sha256:${createHash('sha256').update('').digest('hex')}`;
    expect(caseId({ ...base, stdin: empty })).not.toBe(caseId({ ...base, stdin: null }));
  });

  it('rejects a stored ID that does not match the content', () => {
    const id = caseId(base);
    expect(canonicalCase({ ...base, id }).id).toBe(id);
    expect(() => canonicalCase({ ...base, argv: ['-l'], id })).toThrow(/does not match its content/);
  });

  it('rejects truncated IDs', () => {
    expect(() => canonicalCase({ ...base, id: caseId(base).slice(0, 20) })).toThrow(/64 lowercase hex/);
  });
});

describe('case validation', () => {
  const bad: [string, Partial<CaseInput>][] = [
    ['an absolute fixture path', { fixtures: { '/etc/passwd': blob('b') } }],
    ['a fixture path with ..', { fixtures: { '../x': blob('b') } }],
    ['a fixture path with ./', { fixtures: { './x': blob('b') } }],
    ['a fixture path with an empty segment', { fixtures: { 'a//b': blob('b') } }],
    ['a trailing slash', { fixtures: { 'a/': blob('b') } }],
    ['a fixture that is also a directory', { fixtures: { a: blob('b'), 'a/b/c': blob('c') } }],
    ['a NUL byte in argv', { argv: ['a\0b'] }],
    ['a lone surrogate in argv', { argv: ['\ud800'] }],
    ['an env name with =', { env: { 'A=B': 'x' } }],
    ['an empty env name', { env: { '': 'x' } }],
    ['a malformed blob ref', { stdin: 'blob:sha256:ABC' }],
    ['an unknown origin', { origin: 'fuzzed' as never }],
    ['an empty feature tag', { features: [''] }],
    ['an unknown field', { cwd: 'x' } as never],
  ];
  it.each(bad)('rejects %s', (_, variant) => {
    expect(() => canonicalCase({ ...base, ...variant })).toThrow();
  });

  it('accepts unicode, spaces and backslashes where POSIX does', () => {
    expect(() =>
      canonicalCase({ ...base, argv: ['zażółć', 'a b', '😀'], fixtures: { 'dir name/plik\\1.txt': blob('b') } }),
    ).not.toThrow();
  });
});

describe('observation', () => {
  const obs = {
    exit: 0,
    signal: null,
    timeout: false,
    stdout: blob('1'),
    stderr: blob('2'),
    fs: { created: { 'out.json': blob('3'), 'a.txt': blob('4') }, modified: {}, deleted: ['z', 'b', 'z'] },
    time_ms: { wall: 12, user: 8, sys: 3 },
    rss_kb: 3120,
    runs: 3,
    stable: true,
  };

  it('has a canonical form independent of key and deletion order', () => {
    const reordered = {
      stable: true,
      runs: 3,
      rss_kb: 3120,
      time_ms: { sys: 3, user: 8, wall: 12 },
      fs: { deleted: ['b', 'z'], modified: {}, created: { 'a.txt': blob('4'), 'out.json': blob('3') } },
      stderr: blob('2'),
      stdout: blob('1'),
      timeout: false,
      signal: null,
      exit: 0,
    };
    expect(canonicalObservationJson(reordered)).toBe(canonicalObservationJson(obs));
    expect(canonicalObservation(obs).fs.deleted).toEqual(['b', 'z']);
  });

  it('accepts a process ended by a signal', () => {
    expect(() => canonicalObservation({ ...obs, exit: null, signal: 'SIGKILL', timeout: true })).not.toThrow();
  });

  const bad: [string, object][] = [
    ['both exit and signal', { signal: 'SIGTERM' }],
    ['neither exit nor signal', { exit: null }],
    ['an exit code out of range', { exit: 256 }],
    ['a signal number instead of a name', { exit: null, signal: '9' }],
    ['a path changed twice', { fs: { created: { a: blob('3') }, modified: {}, deleted: ['a'] } }],
    ['zero runs', { runs: 0 }],
    ['a negative time', { time_ms: { wall: -1, user: 0, sys: 0 } }],
    ['a missing field', { stable: undefined }],
  ];
  it.each(bad)('rejects %s', (_, variant) => {
    expect(() => canonicalObservation({ ...obs, ...variant })).toThrow();
  });
});

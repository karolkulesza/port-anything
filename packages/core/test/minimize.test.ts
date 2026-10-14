import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blob-store.js';
import { DEFAULT_MINIMIZE_RUNS, caseSize, ddmin, minimizeCase, type CaseTest } from '../src/minimize.js';
import { canonicalCase, type CanonicalCase, type CaseInput } from '../src/model.js';

describe('ddmin', () => {
  const containsAll =
    (...wanted: number[]) =>
    async (items: number[]) =>
      wanted.every((w) => items.includes(w));

  it('finds the two items a failure needs among many', async () => {
    const items = Array.from({ length: 16 }, (_, i) => i + 1);
    expect(await ddmin(items, containsAll(3, 11))).toEqual([3, 11]);
  });

  it('keeps the order of the items it keeps', async () => {
    expect(await ddmin(['a', 'b', 'c', 'd', 'e'], async (s) => s.includes('e') && s.includes('b'))).toEqual(['b', 'e']);
  });

  it('returns a 1-minimal list: removing any one item loses the failure', async () => {
    // Fails when there are at least 3 even numbers: ddmin keeps exactly 3 of them.
    const test = async (s: number[]) => s.filter((n) => n % 2 === 0).length >= 3;
    const result = await ddmin(Array.from({ length: 20 }, (_, i) => i), test);
    expect(result).toHaveLength(3);
    for (const i of result.keys()) expect(await test(result.filter((_, j) => j !== i))).toBe(false);
  });

  it('tries the empty list first, and returns it when it still fails', async () => {
    const seen: number[][] = [];
    expect(await ddmin([1, 2, 3], async (s) => (seen.push(s), true))).toEqual([]);
    expect(seen).toEqual([[]]);
  });

  it('never tests the whole list, which the caller knows fails', async () => {
    const seen: string[] = [];
    await ddmin([1, 2, 3, 4], async (s) => (seen.push(s.join()), s.includes(4)));
    expect(seen).not.toContain('1,2,3,4');
  });

  it('leaves a list it cannot reduce unchanged', async () => {
    expect(await ddmin([7], containsAll(7))).toEqual([7]);
    expect(await ddmin([], async () => true)).toEqual([]);
    expect(await ddmin([1, 2], containsAll(1, 2))).toEqual([1, 2]);
  });
});

describe('minimizeCase', () => {
  let root: string;
  let store: BlobStore;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pa-minimize-'));
    store = new BlobStore(join(root, 'cache'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  interface Plain {
    argv: string[];
    stdin: string | null;
    fixtures: Record<string, string>;
  }
  const make = async (c: { argv: string[]; stdin?: string | null; fixtures?: Record<string, string>; env?: Record<string, string>; features?: string[] }) => {
    const fixtures: Record<string, string> = {};
    for (const [path, text] of Object.entries(c.fixtures ?? {})) fixtures[path] = await store.put(text);
    const input: CaseInput = {
      argv: c.argv,
      stdin: c.stdin === undefined || c.stdin === null ? null : await store.put(c.stdin),
      fixtures,
      env: c.env ?? {},
      features: c.features ?? [],
      origin: 'generated',
    };
    return canonicalCase(input);
  };
  const plain = async (c: CanonicalCase): Promise<Plain> => {
    const fixtures: Record<string, string> = {};
    for (const [path, ref] of Object.entries(c.fixtures)) fixtures[path] = (await store.get(ref)).toString('latin1');
    return { argv: c.argv, stdin: c.stdin === null ? null : (await store.get(c.stdin)).toString('latin1'), fixtures };
  };
  /** A test on the plain contents that also records every case it was asked about. */
  const recording = (predicate: (c: Plain) => boolean) => {
    const asked: CanonicalCase[] = [];
    const test: CaseTest = async (c) => {
      asked.push(c);
      return predicate(await plain(c));
    };
    return { asked, test };
  };

  it('drops argv tokens, fixtures and stdin the failure does not need, then shrinks what is left by lines and bytes', async () => {
    const source = await make({
      argv: ['-a', '--long', '-L', 'crlf.txt', 'other.txt'],
      stdin: 'one\ntwo\n',
      fixtures: { 'crlf.txt': 'first line\r\nsecond\r\nthird\n', 'other.txt': 'x\ny\n' },
      env: { COLUMNS: '80' },
      features: ['opt.L', 'opt.a'],
    });
    // Fails when -L is given and crlf.txt holds a CR followed by a newline.
    const { test } = recording((c) => c.argv.includes('-L') && c.argv.includes('crlf.txt') && (c.fixtures['crlf.txt'] ?? '').includes('\r\n'));
    const result = await minimizeCase(source, test, { store });
    expect(result.reproduced).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(await plain(result.case)).toEqual({ argv: ['-L', 'crlf.txt'], stdin: null, fixtures: { 'crlf.txt': '\r\n' } });
    // What isn't minimized stays: the environment, and the features, which normalizers may be scoped to.
    expect(result.case).toMatchObject({ env: { COLUMNS: '80' }, features: ['opt.L', 'opt.a'], origin: 'generated' });
  });

  it('shrinks stdin to the one byte that matters, and to no stdin when none is needed', async () => {
    const lastLine = await make({ argv: ['-l'], stdin: 'one\ntwo\nthree' });
    const noNewline = recording((c) => c.stdin !== null && c.stdin !== '' && !c.stdin.endsWith('\n'));
    const result = await minimizeCase(lastLine, noNewline.test, { store });
    // ddmin keeps the first half that still fails, so the first byte of the last line.
    expect(await plain(result.case)).toEqual({ argv: [], stdin: 't', fixtures: {} });

    const usage = await make({ argv: ['-x', 'a.txt'], stdin: 'some input\n', fixtures: { 'a.txt': 'a\n' } });
    const exitCode = recording((c) => c.argv.includes('-x'));
    expect(await plain((await minimizeCase(usage, exitCode.test, { store })).case)).toEqual({ argv: ['-x'], stdin: null, fixtures: {} });
  });

  it('checks the source case first, and stops when it does not fail', async () => {
    const source = await make({ argv: ['-l'], stdin: 'x\n' });
    const { asked, test } = recording(() => false);
    const result = await minimizeCase(source, test, { store });
    expect(result).toMatchObject({ reproduced: false, exhausted: false, runs: 1 });
    expect(result.case.id).toBe(source.id);
    expect(asked.map((c) => c.id)).toEqual([source.id]);
  });

  it('asks about each distinct case once, and counts only those runs', async () => {
    const source = await make({ argv: ['a', 'b', 'c', 'd'], stdin: 'p\nq\nr\n', fixtures: { f: '1\n2\n' } });
    const { asked, test } = recording((c) => c.argv.includes('c') && (c.stdin ?? '').includes('q'));
    const result = await minimizeCase(source, test, { store });
    const ids = asked.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.runs).toBe(ids.length);
    expect(await plain(result.case)).toEqual({ argv: ['c'], stdin: 'q', fixtures: {} });
  });

  it('stops after the run budget with the smallest failing case found so far', async () => {
    const big = Array.from({ length: 64 }, (_, i) => `line ${i}\n`).join('');
    const source = await make({ argv: Array.from({ length: 32 }, (_, i) => `t${i}`), stdin: big });
    const predicate = (c: Plain) => c.argv.includes('t17') && (c.stdin ?? '').includes('line 40\n');
    const { asked, test } = recording(predicate);
    const result = await minimizeCase(source, test, { store, maxRuns: 12 });
    expect(result).toMatchObject({ reproduced: true, exhausted: true, runs: 12 });
    expect(asked).toHaveLength(12);
    expect(predicate(await plain(result.case))).toBe(true);
    expect(caseSize(await plain(result.case))).toBeLessThan(caseSize(await plain(source)));

    // Without the bound it gets all the way down.
    const full = await minimizeCase(source, recording(predicate).test, { store });
    expect(full.exhausted).toBe(false);
    expect(full.runs).toBeLessThanOrEqual(DEFAULT_MINIMIZE_RUNS);
    expect(await plain(full.case)).toEqual({ argv: ['t17'], stdin: 'line 40\n', fixtures: {} });
  });

  it('may drop a fixture the arguments still name, when the failure stays', async () => {
    // Fails whenever b.txt is named: the file itself doesn't matter (the program reports it missing).
    const source = await make({ argv: ['a.txt', 'b.txt'], fixtures: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    const { test } = recording((c) => c.argv.includes('b.txt'));
    expect(await plain((await minimizeCase(source, test, { store })).case)).toEqual({ argv: ['b.txt'], stdin: null, fixtures: {} });
  });
});

describe('caseSize', () => {
  it('counts the bytes of argv, stdin, fixture paths and contents', () => {
    expect(caseSize({ argv: ['-l', 'ab'], stdin: null, fixtures: {} })).toBe(4);
    expect(caseSize({ argv: [], stdin: 'é\n', fixtures: { 'a.txt': 'xy' } })).toBe(3 + 5 + 2);
    expect(caseSize({ argv: [], stdin: Buffer.from([1, 2]), fixtures: { f: Buffer.from([3]) } })).toBe(4);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { compareExact } from '../src/compare.js';
import { DIFF_SHAPES, classifyDiff, classifyText } from '../src/diff-shape.js';
import type { Observation } from '../src/model.js';

const observation = (over: Partial<Observation> = {}): Observation => ({
  exit: 0,
  signal: null,
  timeout: false,
  stdout: blobRef(''),
  stderr: blobRef(''),
  fs: { created: {}, modified: {}, deleted: [] },
  time_ms: { wall: 12, user: null, sys: null },
  rss_kb: null,
  runs: 1,
  stable: true,
  ...over,
});

describe('classifyText', () => {
  it('number formatting: the same values written differently', () => {
    expect(classifyText('total 1\n', 'total 1.0\n')).toEqual({ shape: 'number-format' });
    expect(classifyText('size 1000 bytes, 7 files\n', 'size 1e3 bytes, 007 files\n')).toEqual({ shape: 'number-format' });
    expect(classifyText('ratio 0.50\n', 'ratio .5\n')).toEqual({ shape: 'number-format' });
  });

  it('number values: the same text around different numbers', () => {
    expect(classifyText('  3  12 a.txt\n', '  3  13 a.txt\n')).toEqual({ shape: 'number-value' });
    expect(classifyText('-1\n', '1\n')).toEqual({ shape: 'number-value' });
  });

  it('compares number values exactly, past 2^53 and past the double range', () => {
    expect(classifyText('12345678901234567890\n', '12345678901234567891\n')).toEqual({ shape: 'number-value' });
    expect(classifyText('9007199254740993\n', '9007199254740992\n')).toEqual({ shape: 'number-value' });
    expect(classifyText('1e400\n', '2e400\n')).toEqual({ shape: 'number-value' });
    expect(classifyText('12345678901234567890\n', '1.2345678901234567890e19\n')).toEqual({ shape: 'number-format' });
    expect(classifyText('0.0\n', '-0\n')).toEqual({ shape: 'number-format' });
    expect(classifyText('1.50e-3\n', '0.0015\n')).toEqual({ shape: 'number-format' });
  });

  it('does not take a full stop after the digits as part of the number', () => {
    expect(classifyText('done 3.\n', 'done 3\n').shape).not.toBe('number-format');
  });

  it('is not about numbers when the text around them differs too', () => {
    expect(classifyText('lines 3\n', 'words 3\n')).toEqual({ shape: 'other' });
    expect(classifyText('1 2\n', '1\n2 3\n').shape).not.toMatch(/^number-/);
  });

  it('order only: the same lines, counting repeats, in another order', () => {
    expect(classifyText('a\nb\nb\nc\n', 'c\nb\na\nb\n')).toEqual({ shape: 'line-order' });
    expect(classifyText('a\nb\nb\n', 'a\na\nb\n').shape).not.toBe('line-order');
  });

  it('whitespace only: tabs, spaces, blank lines, line breaks', () => {
    expect(classifyText('  3 a.txt\n', '3\ta.txt\n')).toEqual({ shape: 'whitespace-only' });
    expect(classifyText('a\n\nb\n', 'a\nb\r\n')).toEqual({ shape: 'whitespace-only' });
  });

  it('missing trailing newline, on either side', () => {
    expect(classifyText('3 a.txt\n', '3 a.txt')).toEqual({ shape: 'missing-trailing-newline', detail: 'candidate' });
    expect(classifyText('3 a.txt', '3 a.txt\n')).toEqual({ shape: 'missing-trailing-newline', detail: 'reference' });
  });

  it('an extra blank line after a final newline is not a missing trailing newline', () => {
    expect(classifyText('x 1\n', 'x 1\n\n')).toEqual({ shape: 'whitespace-only' });
    expect(classifyText('x 1\n\n', 'x 1\n')).toEqual({ shape: 'whitespace-only' });
  });

  it('prefix or suffix: cut short, or something extra at either end', () => {
    expect(classifyText('a\nb\nc\n', 'a\nb\n')).toEqual({ shape: 'prefix-suffix', detail: 'candidate stops early' });
    expect(classifyText('a\n', 'a\nwarning: x\n')).toEqual({ shape: 'prefix-suffix', detail: 'candidate adds to the end' });
    expect(classifyText('a\nb\n', 'header\na\nb\n')).toEqual({ shape: 'prefix-suffix', detail: 'candidate adds to the start' });
    expect(classifyText('header\na\n', 'a\n')).toEqual({ shape: 'prefix-suffix', detail: 'candidate misses the start' });
  });

  it('message text only: two different non-empty error messages', () => {
    const shape = classifyText('wc: x: No such file or directory\n', 'error: could not open x\n', 'stderr');
    expect(shape).toEqual({ shape: 'message-text' });
    expect(classifyText('wc: x: No such file or directory\n', 'error: could not open x\n', 'stdout')).toEqual({ shape: 'other' });
  });

  it('empty on one side', () => {
    expect(classifyText('', 'oops\n', 'stderr')).toEqual({ shape: 'empty', detail: 'reference empty' });
    expect(classifyText('3\n', '')).toEqual({ shape: 'empty', detail: 'candidate empty' });
  });

  it('prefers the more specific shape: a dropped final newline is not a prefix, nor whitespace only', () => {
    expect(classifyText('a\n', 'a').shape).toBe('missing-trailing-newline');
    expect(classifyText('a b', 'b a').shape).toBe('other');
  });

  it('works on bytes that are not UTF-8', () => {
    const latin1 = (bytes: number[]) => Buffer.from(bytes).toString('latin1');
    expect(classifyText(latin1([0xff, 0x31, 0x0a]), latin1([0xff, 0x31, 0x2e, 0x30, 0x0a]))).toEqual({ shape: 'number-format' });
  });

  it('refuses equal texts', () => {
    expect(() => classifyText('a', 'a')).toThrow(/equal/);
  });
});

describe('classifyDiff', () => {
  let dir: string;
  let store: BlobStore;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-shape-'));
    store = new BlobStore(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const classify = (a: Observation, b: Observation) => classifyDiff(a, b, compareExact(a, b).fields, store);

  it('exit code change, with both statuses in the detail', async () => {
    expect(await classify(observation(), observation({ exit: 2 }))).toEqual([{ field: 'exit', shape: 'exit-code', detail: '0 vs 2' }]);
    const killed = observation({ exit: null, signal: 'SIGSEGV' });
    expect(await classify(observation({ exit: 1 }), killed)).toEqual([
      { field: 'exit', shape: 'exit-code', detail: '1 vs SIGSEGV' },
      { field: 'signal', shape: 'exit-code', detail: '1 vs SIGSEGV' },
    ]);
    const timedOut = observation({ exit: null, signal: 'SIGKILL', timeout: true });
    expect(await classify(observation(), timedOut)).toContainEqual({ field: 'timeout', shape: 'exit-code', detail: '0 vs timeout' });
  });

  it('classifies stdout and stderr as text, stderr messages as message-text', async () => {
    const a = observation({ exit: 1, stdout: await store.put('1\n'), stderr: await store.put('wc: x: No such file or directory\n') });
    const b = observation({ exit: 1, stdout: await store.put('1.0\n'), stderr: await store.put('cannot open x\n') });
    expect(await classify(a, b)).toEqual([
      { field: 'stdout', shape: 'number-format' },
      { field: 'stderr', shape: 'message-text' },
    ]);
  });

  it('file-set when the changed paths differ, else the content shape of the first differing file', async () => {
    const created = (files: Record<string, string>) => ({ created: files, modified: {}, deleted: [] });
    const a = observation({ fs: created({ 'out.txt': await store.put('b\na\n') }) });
    expect(await classify(a, observation({ fs: created({ 'other.txt': await store.put('b\na\n') }) }))).toEqual([{ field: 'fs', shape: 'file-set' }]);
    expect(await classify(a, observation({ fs: { created: {}, modified: { 'out.txt': await store.put('b\na\n') }, deleted: [] } }))).toEqual([
      { field: 'fs', shape: 'file-set' },
    ]);
    expect(await classify(a, observation({ fs: created({ 'out.txt': await store.put('a\nb\n') }) }))).toEqual([{ field: 'fs', shape: 'line-order' }]);
    expect(await classify(a, observation({ fs: created({ 'out.txt': await store.put('b\na') }) }))).toEqual([
      { field: 'fs', shape: 'missing-trailing-newline', detail: 'candidate' },
    ]);
  });

  it('classifies only the fields it is given', async () => {
    const b = observation({ exit: 2, stdout: await store.put('x\n') });
    expect(await classifyDiff(observation(), b, ['exit'], store)).toEqual([{ field: 'exit', shape: 'exit-code', detail: '0 vs 2' }]);
  });

  it('lists the shapes from the most specific to the catch-all', () => {
    expect(DIFF_SHAPES).toEqual([
      'exit-code',
      'empty',
      'missing-trailing-newline',
      'whitespace-only',
      'line-order',
      'number-format',
      'number-value',
      'prefix-suffix',
      'message-text',
      'file-set',
      'other',
    ]);
  });
});

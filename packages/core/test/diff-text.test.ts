import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { fieldDiffLines, fieldOutputs, lineDiff, savedFieldDiffs } from '../src/diff-text.js';
import { canonicalObservation, type Observation } from '../src/model.js';

const observation = (exit: number, stdout: string, stderr = '', created: Record<string, string> = {}): Observation =>
  canonicalObservation({
    exit,
    signal: null,
    timeout: false,
    stdout: blobRef(stdout),
    stderr: blobRef(stderr),
    fs: { created: Object.fromEntries(Object.entries(created).map(([path, content]) => [path, blobRef(content)])), modified: {}, deleted: [] },
    time_ms: { wall: 1, user: null, sys: null },
    rss_kb: null,
    runs: 1,
    stable: true,
  });

describe('fieldOutputs and savedFieldDiffs', () => {
  let dir: string;
  let store: BlobStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-diff-text-'));
    store = new BlobStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves stdout and stderr as blob refs and the other fields as text, and reads them back', async () => {
    for (const text of ['a\nb\n', 'a\nc\n', 'oops\n', '']) await store.put(text);
    const reference = observation(0, 'a\nb\n', '', { 'out.txt': 'x' });
    const candidate = observation(2, 'a\nc\n', 'oops\n');
    const saved = fieldOutputs(reference, candidate, ['exit', 'stdout', 'stderr', 'fs']);
    expect(saved.find((o) => o.field === 'stdout')).toEqual({ field: 'stdout', reference: blobRef('a\nb\n'), candidate: blobRef('a\nc\n') });
    expect(saved.find((o) => o.field === 'exit')).toEqual({ field: 'exit', reference: '0', candidate: '2' });
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved); // fits in run.json as is
    const lines = (await savedFieldDiffs(saved, store)).flatMap(fieldDiffLines);
    expect(lines).toEqual([
      'exit: reference 0, candidate 2',
      'stdout:',
      '  @@ line 2',
      '    a',
      '  - b',
      '  + c',
      'stderr:',
      '  @@ line 1',
      '  + oops',
      'fs:',
      '  @@ line 1',
      `  - created out.txt ${blobRef('x').slice('blob:sha256:'.length, 'blob:sha256:'.length + 12)}`,
      '  + ',
    ]);
  });

  it('says so when an output is no longer in the cache, or is not text', async () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    await store.put(bytes);
    const saved = [{ field: 'stdout' as const, reference: blobRef('gone'), candidate: blobRef(bytes) }];
    const [d] = await savedFieldDiffs(saved, store);
    expect(d!.reference).toMatch(/^<not readable from the cache \(no longer there\), sha256 [0-9a-f]{12}>$/);
    expect(d!.candidate).toMatch(/^<2 bytes, not UTF-8, sha256 [0-9a-f]{12}>$/);
  });
});

describe('fieldOutputs: changed files', () => {
  it('keeps only the files that differ, so a difference past the 50th file still shows', () => {
    const files = (changed: string) => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, '0')}`, i === 55 ? changed : 'same']));
    const [saved] = fieldOutputs(observation(0, '', '', files('one')), observation(0, '', '', files('two')), ['fs']);
    const hash = (text: string) => blobRef(text).slice('blob:sha256:'.length, 'blob:sha256:'.length + 12);
    expect(saved).toEqual({ field: 'fs', reference: `(59 unchanged)\ncreated f55 ${hash('one')}\n`, candidate: `(59 unchanged)\ncreated f55 ${hash('two')}\n` });
    expect(fieldDiffLines(saved!)).toEqual(['fs:', '  @@ line 2', '    (59 unchanged)', `  - created f55 ${hash('one')}`, `  + created f55 ${hash('two')}`]);
  });

  it('counts what differs past 50 files a side', () => {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`f${i}`, `x${i}`]));
    const [saved] = fieldOutputs(observation(0, '', '', many), observation(0, ''), ['fs']);
    expect(saved!.reference.split('\n').slice(-2)).toEqual(['(20 more)', '']);
    expect(saved!.candidate).toBe('\n');
  });
});

describe('lineDiff', () => {
  it('shows only the changed lines, with a little context, and makes invisible characters visible', () => {
    expect(lineDiff('same\n', 'same\n')).toEqual([]);
    expect(lineDiff('1\n2\n3\n4\n', '1\n2\n3\nX\n')).toEqual(['@@ line 4', '  2', '  3', '- 4', '+ X']);
    expect(lineDiff('a b\n', 'a b \n')).toEqual(['@@ line 1', '- a b', '+ "a b "']);
  });
});

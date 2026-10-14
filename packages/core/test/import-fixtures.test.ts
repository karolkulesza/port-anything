import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { ImportCollector } from '../src/import.js';
import { importCases } from '../src/importers.js';
import { canonicalCase } from '../src/model.js';

const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software';

let dir: string;
let src: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-import-'));
  src = join(dir, 'project');
  await mkdir(join(src, '.git'), { recursive: true });
  await mkdir(join(src, 'fixtures', 'nested'), { recursive: true });
  await writeFile(join(src, 'LICENSE'), MIT);
  await writeFile(join(src, 'fixtures', 'b.csv'), 'b,2\n');
  await writeFile(join(src, 'fixtures', 'a.csv'), 'a,1\n');
  await writeFile(join(src, 'fixtures', 'nested', 'c.csv'), 'c,3\n');
  store = new BlobStore(join(dir, 'cache'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ImportCollector', () => {
  it('stores blobs and returns canonical imported cases', async () => {
    const collector = new ImportCollector(store);
    await collector.add({ argv: ['-n', '3'], stdin: 'x\n', fixtures: { 'in.txt': 'data' }, features: ['b', 'a', 'b'], at: { file: 'f', line: 1 } });
    const [imported] = collector.cases;
    expect(imported!.case).toEqual(
      canonicalCase({ argv: ['-n', '3'], stdin: blobRef('x\n'), fixtures: { 'in.txt': blobRef('data') }, features: ['a', 'b'], origin: 'imported' }),
    );
    expect(imported!.at).toEqual({ file: 'f', line: 1 });
    expect((await store.get(blobRef('x\n'))).toString()).toBe('x\n');
    expect((await store.get(blobRef('data'))).toString()).toBe('data');
  });

  it('keeps the first of several entries with the same case ID and lists the others', async () => {
    const collector = new ImportCollector(store);
    await collector.add({ argv: ['.'], stdin: '1\n', at: { file: 'f', line: 1 } });
    await collector.add({ argv: ['.'], stdin: '1\n', at: { file: 'f', line: 5 }, features: ['other'] });
    expect(collector.cases.map((c) => c.at.line)).toEqual([1]);
    expect(collector.duplicates).toEqual([{ file: 'f', line: 5 }]);
  });

  it('skips an entry the case model rejects, with the reason', async () => {
    const collector = new ImportCollector(store);
    await collector.add({ argv: ['a\0b'], stdin: null, at: { file: 'f', line: 3 } });
    await collector.add({ argv: ['x'], stdin: null, fixtures: { '../escape': '' }, at: { file: 'f', line: 4 } });
    expect(collector.cases).toEqual([]);
    expect(collector.skipped).toEqual([
      { at: { file: 'f', line: 3 }, reason: expect.stringMatching(/argv\.0: must not contain a NUL byte/) },
      { at: { file: 'f', line: 4 }, reason: expect.stringMatching(/fixtures\.\.\.\/escape/) },
    ]);
  });
});

describe('importCases: fixtures', () => {
  it('makes one case per file, in path order, with the file in the working directory', async () => {
    const result = await importCases({ kind: 'fixtures', path: join(src, 'fixtures'), argv: ['--count'] }, store);
    expect(result.kind).toBe('fixtures');
    expect(result.cases.map((c) => c.case.argv)).toEqual([['--count', 'a.csv'], ['--count', 'b.csv'], ['--count', 'nested/c.csv']]);
    expect(result.cases.every((c) => c.case.origin === 'imported')).toBe(true);
    expect(result.cases[2]!.case.fixtures).toEqual({ 'nested/c.csv': blobRef('c,3\n') });
    expect(result.cases[2]!.case.stdin).toBeNull();
    expect(result.cases[2]!.at).toEqual({ file: join(src, 'fixtures', 'nested', 'c.csv') });
  });

  it('puts the path where {} appears in argv', async () => {
    const result = await importCases({ kind: 'fixtures', path: join(src, 'fixtures'), argv: ['--in={}', '-o', 'out'] }, store);
    expect(result.cases[0]!.case.argv).toEqual(['--in=a.csv', '-o', 'out']);
  });

  it('can feed fixtures on stdin instead', async () => {
    const result = await importCases({ kind: 'fixtures', path: join(src, 'fixtures'), argv: ['-s'], input: 'stdin' }, store);
    expect(result.cases.map((c) => c.case.stdin)).toEqual([blobRef('a,1\n'), blobRef('b,2\n'), blobRef('c,3\n')]);
    expect(result.cases.every((c) => c.case.argv.join() === '-s' && Object.keys(c.case.fixtures).length === 0)).toBe(true);
    await expect(importCases({ kind: 'fixtures', path: src, argv: ['{}'], input: 'stdin' }, store)).rejects.toThrow(/can't be used/);
  });

  it('accepts a single file', async () => {
    const result = await importCases({ kind: 'fixtures', path: join(src, 'fixtures', 'b.csv') }, store);
    expect(result.cases.map((c) => c.case.argv)).toEqual([['b.csv']]);
    expect(result.cases[0]!.case.fixtures).toEqual({ 'b.csv': blobRef('b,2\n') });
  });

  it('skips symlinks and files over the size limit, and de-duplicates identical cases', async () => {
    await writeFile(join(src, 'fixtures', 'big.csv'), 'x'.repeat(100));
    await symlink(join(src, 'fixtures', 'a.csv'), join(src, 'fixtures', 'link.csv'));
    await writeFile(join(src, 'fixtures', 'copy.csv'), 'a,1\n');
    const result = await importCases({ kind: 'fixtures', path: join(src, 'fixtures'), input: 'stdin', maxBytes: 50 }, store);
    expect(result.cases.map((c) => c.at.file)).toEqual([join(src, 'fixtures', 'a.csv'), join(src, 'fixtures', 'b.csv'), join(src, 'fixtures', 'nested', 'c.csv')]);
    expect(result.duplicates).toEqual([{ file: join(src, 'fixtures', 'copy.csv') }]);
    expect(result.skipped).toEqual([
      { at: { file: join(src, 'fixtures', 'big.csv') }, reason: 'larger than 50 bytes' },
      { at: { file: join(src, 'fixtures', 'link.csv') }, reason: 'symbolic link' },
    ]);
  });

  it('records the license check of the source', async () => {
    const result = await importCases({ kind: 'fixtures', path: join(src, 'fixtures') }, store);
    expect(result.license).toEqual({ licenses: ['MIT'], category: 'permissive', method: 'detected', files: [join(src, 'LICENSE')] });
    const declared = await importCases({ kind: 'fixtures', path: join(src, 'fixtures'), license: 'GPL-3.0-only' }, store);
    expect(declared.license).toMatchObject({ licenses: ['GPL-3.0-only'], category: 'copyleft', method: 'declared' });
    expect(declared.license.warning).toBeDefined();
  });

  it('refuses an unknown source kind', async () => {
    await expect(importCases({ kind: 'bats', path: src } as never, store)).rejects.toThrow(/Unknown import source "bats".*fixtures, jq-test/);
  });
});

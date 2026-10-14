import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, cacheDir } from '../src/blob-store.js';
import { RECORDED_DIR, loadCommittedCases } from '../src/committed-cases.js';
import { ConfigError } from '../src/config.js';
import { canonicalCase } from '../src/model.js';

describe('loadCommittedCases', () => {
  let project: string;
  let store: BlobStore;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pa-committed-'));
    store = new BlobStore(cacheDir(project));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const write = (file: string, lines: readonly (object | string)[]) => {
    mkdirSync(join(project, RECORDED_DIR), { recursive: true });
    writeFileSync(join(project, RECORDED_DIR, file), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  };

  it('means zero cases when the directory is missing or empty', async () => {
    expect(await loadCommittedCases(project, store)).toEqual([]);
    mkdirSync(join(project, RECORDED_DIR), { recursive: true });
    expect(await loadCommittedCases(project, store)).toEqual([]);
  });

  it('puts inline stdin and fixtures (text or base64) into the blob store and returns cases with refs', async () => {
    const binary = Buffer.from([0, 0xff, 0x10]);
    write('recorded.jsonl', [
      { argv: ['-n', 'in.txt'], stdin: 'hello\n', fixtures: { 'in.txt': 'a\nb\n', 'data/raw.bin': { base64: binary.toString('base64') } }, env: { COLUMNS: '80' }, features: ['opt.n'], origin: 'recorded' },
      { argv: [], stdin: null, origin: 'recorded' },
    ]);
    const cases = await loadCommittedCases(project, store);
    expect(cases).toHaveLength(2);
    const [first, second] = cases;
    expect(first).toEqual(
      canonicalCase({
        argv: ['-n', 'in.txt'],
        stdin: await store.put('hello\n'),
        fixtures: { 'in.txt': await store.put('a\nb\n'), 'data/raw.bin': await store.put(binary) },
        env: { COLUMNS: '80' },
        features: ['opt.n'],
        origin: 'recorded',
      }),
    );
    expect(await store.get(first!.fixtures['data/raw.bin']!)).toEqual(binary);
    expect(second).toMatchObject({ argv: [], stdin: null, fixtures: {}, env: {}, origin: 'recorded' });
  });

  it('reads every *.jsonl file in name order, skips blank lines, and keeps one copy of a case found twice', async () => {
    write('b-import.jsonl', [{ argv: ['b'], origin: 'imported' }, '', { argv: ['shared'], origin: 'imported' }]);
    write('a-import.jsonl', [{ argv: ['a'], origin: 'imported' }, { argv: ['shared'], origin: 'imported' }]);
    write('notes.txt', ['not a case']);
    const cases = await loadCommittedCases(project, store);
    expect(cases.map((c) => c.argv)).toEqual([['a'], ['shared'], ['b']]);
  });

  it('checks an id given in the file against the content', async () => {
    const id = canonicalCase({ argv: ['x'], stdin: await store.put('in'), origin: 'recorded' }).id;
    write('recorded.jsonl', [{ id, argv: ['x'], stdin: 'in', origin: 'recorded' }]);
    expect((await loadCommittedCases(project, store))[0]!.id).toBe(id);
    write('recorded.jsonl', [{ id, argv: ['x'], stdin: 'changed', origin: 'recorded' }]);
    await expect(loadCommittedCases(project, store)).rejects.toThrow(/recorded\.jsonl:1: Case ID .* does not match its content/);
  });

  it('names the file and line of a broken case (ConfigError)', async () => {
    const problem = async (line: object | string) => {
      write('recorded.jsonl', [{ argv: [], origin: 'recorded' }, line]);
      const error = await loadCommittedCases(project, store).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    };
    expect(await problem('{not json')).toMatch(/^port-anything\/recorded\/recorded\.jsonl:2: not valid JSON/);
    expect(await problem({ argv: [], origin: 'recorded', stdn: 'typo' })).toMatch(/recorded\.jsonl:2: .*stdn/);
    expect(await problem({ argv: [], origin: 'made-up' })).toMatch(/recorded\.jsonl:2: .*origin/);
    expect(await problem({ argv: [], origin: 'recorded', stdin: { base64: 'not base64!' } })).toMatch(/recorded\.jsonl:2: .*stdin/);
    expect(await problem({ argv: [], origin: 'recorded', fixtures: { '../out': 'x' } })).toMatch(/recorded\.jsonl:2: .*fixtures/);
    expect(await problem('{"argv":[],"origin":"recorded","fixtures":{"__proto__":"x"}}')).toMatch(/recorded\.jsonl:2: .*__proto__/);
    expect(await problem('[]')).toMatch(/recorded\.jsonl:2: /);
  });
});

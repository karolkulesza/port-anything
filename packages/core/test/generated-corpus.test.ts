import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, blobRef, cacheDir } from '../src/blob-store.js';
import { parseCliSpec } from '../src/cli-spec.js';
import { ConfigError, parseConfig } from '../src/config.js';
import {
  DEFAULT_GENERATOR_SEED,
  GENERATED_CORPUS_FILE,
  SEEDS_DIR,
  generatedCorpusKey,
  generatedCorpusSettings,
  readCachedCorpusOutline,
  readGeneratedCorpusCache,
  readSeedFixtures,
  writeGeneratedCorpusCache,
  type GeneratedCorpusKeyInput,
} from '../src/generated-corpus.js';
import { canonicalCase } from '../src/model.js';

const base = { version: 1, reference: { cmd: './ref' }, candidate: { cmd: './port' } };

describe('generatedCorpusSettings', () => {
  it('is undefined without corpus.generator and corpus.generator_seed: the project has only committed cases', () => {
    expect(generatedCorpusSettings(parseConfig(base))).toBeUndefined();
    expect(generatedCorpusSettings(parseConfig({ ...base, corpus: { repeats: 3 } }))).toBeUndefined();
  });

  it('reads the generator, seed, budget and filters, with the generator defaults for what is left out', () => {
    expect(generatedCorpusSettings(parseConfig({ ...base, corpus: { generator: 'v1', generator_seed: 7, budget: 60 } }))).toEqual({
      generator: 'v1',
      seed: 7,
      budget: 60,
      errorPathCap: 0.3,
      minCasesPerFeature: 20,
    });
    expect(generatedCorpusSettings(parseConfig({ ...base, corpus: { generator: 'v1', generator_seed: 0, budget: 5, error_path_cap: 0.5, min_cases_per_feature: 3 } }))).toEqual({
      generator: 'v1',
      seed: 0,
      budget: 5,
      errorPathCap: 0.5,
      minCasesPerFeature: 3,
    });
    expect(generatedCorpusSettings(parseConfig({ ...base, corpus: { generator: 'v1', generator_seed: 1 } }))?.budget).toBe(10_000);
  });

  it('needs both the generator and the seed, since the cases depend on both', () => {
    expect(() => generatedCorpusSettings(parseConfig({ ...base, corpus: { generator: 'v1' } }))).toThrow(ConfigError);
    expect(() => generatedCorpusSettings(parseConfig({ ...base, corpus: { generator: 'v1' } }))).toThrow(/corpus\.generator_seed is not set/);
    expect(() => generatedCorpusSettings(parseConfig({ ...base, corpus: { generator_seed: 3 } }))).toThrow(/corpus\.generator is not set/);
  });

  it('has 42 as the default seed, the one compare uses', () => {
    expect(DEFAULT_GENERATOR_SEED).toBe(42);
  });
});

describe('generatedCorpusKey', () => {
  const spec = parseCliSpec({ version: 1, program: 'tool', flags: [{ names: ['-q', '--quiet'], feature: 'opt.quiet', arity: 0 }] });
  const input: GeneratedCorpusKeyInput = {
    settings: { generator: 'v1', seed: 42, budget: 60, errorPathCap: 0.3, minCasesPerFeature: 20 },
    spec,
    seeds: [],
    reference: './ref',
    programName: 'tool',
    timeoutMs: 10_000,
    envAllowlist: [],
    env: {},
  };

  it('is the same for the same inputs, however the objects are ordered', () => {
    const reordered = { ...input, env: {}, settings: { minCasesPerFeature: 20, errorPathCap: 0.3, budget: 60, seed: 42, generator: 'v1' as const } };
    expect(generatedCorpusKey(reordered)).toBe(generatedCorpusKey(input));
    expect(generatedCorpusKey(input)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes with everything the generated cases depend on', () => {
    const key = generatedCorpusKey(input);
    const changed: Partial<GeneratedCorpusKeyInput>[] = [
      { settings: { ...input.settings, seed: 43 } },
      { settings: { ...input.settings, budget: 61 } },
      { settings: { ...input.settings, errorPathCap: 0.2 } },
      { settings: { ...input.settings, minCasesPerFeature: 10 } },
      { spec: parseCliSpec({ version: 1, program: 'tool', flags: [{ names: ['-v'], feature: 'opt.v', arity: 0 }] }) },
      { seeds: [new Uint8Array([1])] },
      { reference: ['./ref', '--strict'] },
      { programName: 'other' },
      { timeoutMs: 5000 },
      { envAllowlist: ['COLUMNS'] },
      { env: { LANG: 'C' } },
    ];
    for (const change of changed) expect(generatedCorpusKey({ ...input, ...change }), JSON.stringify(change)).not.toBe(key);
  });

  it('changes with the committed cases and their features from generator v2 on, which v1 ignores', () => {
    const committed = [{ id: 'sha256:a', features: ['opt.quiet'] }];
    expect(generatedCorpusKey({ ...input, committed })).toBe(generatedCorpusKey(input));
    const v2 = { ...input, settings: { ...input.settings, generator: 'v2' as const } };
    const key = generatedCorpusKey({ ...v2, committed });
    expect(generatedCorpusKey(v2)).not.toBe(key);
    expect(generatedCorpusKey({ ...v2, committed: [{ id: 'sha256:a', features: ['base'] }] })).not.toBe(key);
    expect(generatedCorpusKey({ ...v2, committed: [{ id: 'sha256:b', features: ['opt.quiet'] }, ...committed] })).not.toBe(key);
    expect(generatedCorpusKey({ ...v2, committed: [...committed, { id: 'sha256:0', features: [] }] })).toBe(
      generatedCorpusKey({ ...v2, committed: [{ id: 'sha256:0', features: [] }, ...committed] }),
    );
  });
});

describe('the generated corpus cache', () => {
  let project: string;
  let store: BlobStore;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pa-generated-'));
    store = new BlobStore(cacheDir(project));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const record = async () => {
    const stdin = await store.put('hello\n');
    const fixture = await store.put('a b\n');
    const cases = [
      canonicalCase({ argv: ['-q'], stdin, features: ['opt.q'], origin: 'generated' }),
      canonicalCase({ argv: ['in.txt'], fixtures: { 'in.txt': fixture }, features: ['base'], origin: 'generated' }),
    ];
    return {
      key: `sha256:${'1'.repeat(64)}`,
      settings: { generator: 'v1' as const, seed: 42, budget: 60, errorPathCap: 0.3, minCasesPerFeature: 20 },
      cases,
      stats: { observed: 3, dropped: { duplicate: 1, errorCap: 0, budget: 0 }, stop: 'exhausted' as const, underSampled: [] },
      skipped: [],
    };
  };

  it('reads back what was written, under the same key, from .port-anything/cache/', async () => {
    const written = await record();
    await writeGeneratedCorpusCache(project, written);
    expect(GENERATED_CORPUS_FILE).toBe('generated-corpus.json');
    expect(await readGeneratedCorpusCache(project, written.key, store)).toEqual(written);
  });

  it('misses when there is no cache, the key differs, the file is damaged, or a blob is gone', async () => {
    const written = await record();
    expect(await readGeneratedCorpusCache(project, written.key, store)).toBeUndefined();
    await writeGeneratedCorpusCache(project, written);
    expect(await readGeneratedCorpusCache(project, `sha256:${'2'.repeat(64)}`, store)).toBeUndefined();
    rmSync(store.path(written.cases[1]!.fixtures['in.txt']!));
    expect(await readGeneratedCorpusCache(project, written.key, store)).toBeUndefined();
    writeFileSync(join(cacheDir(project), GENERATED_CORPUS_FILE), '{"version": 1, "key": ');
    expect(await readGeneratedCorpusCache(project, written.key, store)).toBeUndefined();
  });

  it('keeps the key without the committed cases and the commonest error answer', async () => {
    const written = await record();
    const commonestError = { exit: 2, signal: null, timeout: false, stdout: blobRef(''), stderr: blobRef('usage: tool\n'), answers: 2 };
    const full = { ...written, keyWithoutCommitted: `sha256:${'3'.repeat(64)}`, stats: { ...written.stats, commonestError } };
    await writeGeneratedCorpusCache(project, full);
    expect(await readGeneratedCorpusCache(project, written.key, store)).toEqual(full);
  });

  it("outlines the cached corpus under any key, blobs or not: what the cases were before a command regenerates them", async () => {
    expect(await readCachedCorpusOutline(project)).toBeUndefined();
    const written = await record();
    await writeGeneratedCorpusCache(project, { ...written, keyWithoutCommitted: `sha256:${'3'.repeat(64)}` });
    rmSync(store.path(written.cases[0]!.stdin!));
    expect(await readCachedCorpusOutline(project)).toEqual({
      key: written.key,
      keyWithoutCommitted: `sha256:${'3'.repeat(64)}`,
      cases: written.cases.map((c) => ({ id: c.id, features: c.features })),
    });
    await writeGeneratedCorpusCache(project, written);
    expect(await readCachedCorpusOutline(project)).not.toHaveProperty('keyWithoutCommitted');
    writeFileSync(join(cacheDir(project), GENERATED_CORPUS_FILE), '{"version": 1, "key": ');
    expect(await readCachedCorpusOutline(project)).toBeUndefined();
  });

  it('copies the blobs from another store, for a copy of the project that has no cache of its own', async () => {
    const written = await record();
    await writeGeneratedCorpusCache(project, written);
    const copy = mkdtempSync(join(tmpdir(), 'pa-generated-copy-'));
    try {
      const copyStore = new BlobStore(cacheDir(copy));
      expect(await readGeneratedCorpusCache(project, written.key, copyStore, store)).toEqual(written);
      expect((await copyStore.get(written.cases[0]!.stdin!)).toString()).toBe('hello\n');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('readSeedFixtures', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pa-seeds-'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('reads every file under port-anything/seeds/, in path order; none without the directory', async () => {
    expect(await readSeedFixtures(project)).toEqual([]);
    mkdirSync(join(project, SEEDS_DIR, 'sub'), { recursive: true });
    writeFileSync(join(project, SEEDS_DIR, 'b.txt'), 'b');
    writeFileSync(join(project, SEEDS_DIR, 'a.txt'), 'a');
    writeFileSync(join(project, SEEDS_DIR, 'sub', 'c.bin'), Buffer.from([0, 1]));
    const seeds = await readSeedFixtures(project);
    expect(seeds.map((s) => Buffer.from(s).toString('hex'))).toEqual(['61', '62', '0001']);
  });
});

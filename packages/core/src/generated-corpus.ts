import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { blobRef, cacheDir, type BlobStore } from './blob-store.js';
import { canonicalJson } from './canonical-json.js';
import type { CliSpec } from './cli-spec.js';
import { ConfigError, type Config } from './config.js';
import { DEFAULT_BUDGET, DEFAULT_ERROR_PATH_CAP, DEFAULT_MIN_CASES_PER_FEATURE, type CorpusStats } from './corpus-generator.js';
import { CaseSchema, canonicalCase, type CanonicalCase } from './model.js';
import { GENERATOR_VERSIONS, type GeneratorVersion } from './rng.js';

/** The seed a new generated corpus starts from, and the one every `compare` run uses. */
export const DEFAULT_GENERATOR_SEED = 42;

/** Seed fixtures for byte mutation, committed. */
export const SEEDS_DIR = 'port-anything/seeds';

/** The expanded generated corpus, inside the (git-ignored) cache directory. */
export const GENERATED_CORPUS_FILE = 'generated-corpus.json';

/** What a project's generated corpus is generated from, out of `port-anything.yaml`. */
export interface GeneratedCorpusSettings {
  generator: GeneratorVersion;
  seed: number;
  budget: number;
  errorPathCap: number;
  minCasesPerFeature: number;
}

/**
 * The generator settings of `corpus`, or undefined when the project has no generated corpus
 * (neither `corpus.generator` nor `corpus.generator_seed` is set). A corpus needs both, since its
 * cases depend on both. A `ConfigError` when only one is set.
 */
export function generatedCorpusSettings(config: Config): GeneratedCorpusSettings | undefined {
  const corpus = config.corpus;
  if (corpus?.generator === undefined && corpus?.generator_seed === undefined) return undefined;
  if (corpus.generator === undefined) throw new ConfigError('corpus.generator is not set, but corpus.generator_seed is: set both (port-anything generate does).');
  if (corpus.generator_seed === undefined) throw new ConfigError('corpus.generator_seed is not set, but corpus.generator is: set both (port-anything generate does).');
  return {
    generator: corpus.generator,
    seed: corpus.generator_seed,
    budget: corpus.budget ?? DEFAULT_BUDGET,
    errorPathCap: corpus.error_path_cap ?? DEFAULT_ERROR_PATH_CAP,
    minCasesPerFeature: corpus.min_cases_per_feature ?? DEFAULT_MIN_CASES_PER_FEATURE,
  };
}

/** Everything the generated cases depend on, apart from the reference's own behavior. */
export interface GeneratedCorpusKeyInput {
  settings: GeneratedCorpusSettings;
  spec: CliSpec;
  /** Seed fixtures, in the order the generator gets them. */
  seeds: readonly Uint8Array[];
  /** The reference as configured. */
  reference: string | readonly string[];
  /** The argv[0] the reference runs as. */
  programName: string;
  /** How the reference runs while generating (`sandbox.timeout`, `sandbox.env_allowlist`, `sandbox.env`). */
  timeoutMs: number;
  envAllowlist: readonly string[];
  env: Readonly<Record<string, string>>;
}

/**
 * The cache key of a generated corpus: a hash of its settings, the CLI spec, the seed fixtures and
 * how the reference runs. A rebuilt reference keeps the key; `port-anything generate` regenerates.
 */
export function generatedCorpusKey(input: GeneratedCorpusKeyInput): string {
  const json = canonicalJson({
    version: 1,
    settings: input.settings,
    spec: input.spec,
    seeds: input.seeds.map((s) => blobRef(s)),
    reference: input.reference,
    program_name: input.programName,
    timeout_ms: input.timeoutMs,
    env_allowlist: input.envAllowlist,
    env: input.env,
  });
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

/** The generated corpus as cached: its cases (content in the blob store) and how generation went. */
export interface GeneratedCorpusCache {
  key: string;
  settings: GeneratedCorpusSettings;
  cases: CanonicalCase[];
  stats: CorpusStats;
  /** Destructive subcommands left out. */
  skipped: string[];
}

const count = z.int().min(0);
const CacheSchema = z.strictObject({
  version: z.literal(1),
  key: z.string(),
  settings: z.strictObject({
    generator: z.enum(GENERATOR_VERSIONS),
    seed: count,
    budget: count,
    errorPathCap: z.number().min(0).max(1),
    minCasesPerFeature: count,
  }),
  cases: z.array(z.unknown()),
  stats: z.strictObject({
    observed: count,
    dropped: z.strictObject({ duplicate: count, errorCap: count, budget: count }),
    stop: z.enum(['exhausted', 'budget', 'time']),
    underSampled: z.array(z.strictObject({ feature: z.string(), cases: count })),
  }),
  skipped: z.array(z.string()),
});

/**
 * The cached generated corpus, when it was generated under `key` and the blob store holds the
 * content of every case; undefined otherwise (no cache, other settings, a damaged file, a blob
 * gone), so the caller regenerates. With `from`, missing blobs are copied from that store: a copy
 * of the project reads the original's cache this way.
 */
export async function readGeneratedCorpusCache(projectDir: string, key: string, store: BlobStore, from?: BlobStore): Promise<GeneratedCorpusCache | undefined> {
  let parsed;
  try {
    parsed = CacheSchema.safeParse(JSON.parse(await readFile(join(cacheDir(projectDir), GENERATED_CORPUS_FILE), 'utf8')));
  } catch {
    return undefined;
  }
  if (!parsed.success || parsed.data.key !== key) return undefined;
  const cases: CanonicalCase[] = [];
  for (const raw of parsed.data.cases) {
    const c = CaseSchema.safeParse(raw);
    if (!c.success) return undefined;
    let canonical: CanonicalCase;
    try {
      canonical = canonicalCase(c.data);
    } catch {
      return undefined;
    }
    for (const ref of [...(canonical.stdin === null ? [] : [canonical.stdin]), ...Object.values(canonical.fixtures)]) {
      if (await store.has(ref)) continue;
      if (from === undefined) return undefined;
      try {
        await store.put(await from.get(ref));
      } catch {
        return undefined;
      }
    }
    cases.push(canonical);
  }
  const { version: _version, ...rest } = parsed.data;
  return { ...rest, cases };
}

/** Writes the generated corpus to the cache (its blobs must already be in the project's store). */
export async function writeGeneratedCorpusCache(projectDir: string, corpus: GeneratedCorpusCache): Promise<void> {
  const dir = cacheDir(projectDir);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${GENERATED_CORPUS_FILE}.${randomBytes(6).toString('hex')}`);
  await writeFile(temp, `${JSON.stringify({ version: 1, ...corpus })}\n`);
  await rename(temp, join(dir, GENERATED_CORPUS_FILE));
}

/** Every file under `port-anything/seeds/`, in path order; none when there is no such directory. */
export async function readSeedFixtures(projectDir: string): Promise<Uint8Array[]> {
  const dir = join(projectDir, SEEDS_DIR);
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigError(`Cannot read ${SEEDS_DIR}: ${(e as Error).message}`);
  }
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Promise.all(files.map(async (file) => new Uint8Array(await readFile(join(dir, file)))));
}

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { BlobStore } from './blob-store.js';
import { canonicalJson } from './canonical-json.js';
import { ConfigError } from './config.js';
import { FingerprintSchema, fingerprintDifferences, type Fingerprint, type FingerprintField } from './fingerprint.js';
import type { GeneratedCorpusSettings } from './generated-corpus.js';
import { CaseIdSchema, type CanonicalCase, type Observation } from './model.js';
import { normalizePair, type NormalizerSpec, type SideContext } from './normalize.js';
import { defaultConcurrency, defaultContainerConcurrency, mapPool } from './pool.js';
import { pinPrograms } from './program.js';
import { GENERATOR_VERSIONS } from './rng.js';
import { observeCase, openContainers, sideContexts, type RunCasesOptions } from './run-cases.js';

/** The frozen corpus, committed: `.port-anything/MANIFEST.json`. */
export const MANIFEST_FILE = 'MANIFEST.json';

export function manifestPath(projectDir: string): string {
  return join(projectDir, '.port-anything', MANIFEST_FILE);
}

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 lowercase hex>');
const count = z.int().min(0);

const ManifestSchema = z.strictObject({
  version: z.literal(1),
  /** The port-anything version that froze the corpus; informational, a newer one verifies it too. */
  tool_version: z.string().min(1),
  /** What the generated cases come from; null when the project has none. */
  generator: z
    .strictObject({
      version: z.enum(GENERATOR_VERSIONS),
      seed: count,
      budget: count,
      error_path_cap: z.number().min(0).max(1),
      min_cases_per_feature: count,
    })
    .nullable(),
  /** The configured normalizers, as parsed. */
  normalizers: z.array(z.record(z.string(), z.unknown())),
  /** The machine the observations were made on. */
  fingerprint: FingerprintSchema,
  /** Every case of the corpus, sorted by ID. */
  cases: z.array(
    z.strictObject({
      id: CaseIdSchema,
      features: z.array(z.string()),
      /** Hash of the reference's normalized observation; null for a flaky-reference case, which has none. */
      observation: HashSchema.nullable(),
    }),
  ),
});

export type Manifest = z.output<typeof ManifestSchema>;
export type ManifestCase = Manifest['cases'][number];

/** The manifest's form of the generator settings. */
export function manifestGenerator(settings: GeneratedCorpusSettings | undefined): Manifest['generator'] {
  if (settings === undefined) return null;
  return {
    version: settings.generator,
    seed: settings.seed,
    budget: settings.budget,
    error_path_cap: settings.errorPathCap,
    min_cases_per_feature: settings.minCasesPerFeature,
  };
}

/** Normalizer specs as plain JSON (no undefined members), as the manifest stores them. */
export function manifestNormalizers(normalizers: readonly NormalizerSpec[]): Manifest['normalizers'] {
  return JSON.parse(JSON.stringify(normalizers)) as Manifest['normalizers'];
}

/** The manifest's entries for these cases, sorted by ID; `observations` maps case ID to hash (absent: flaky). */
export function manifestCases(cases: readonly CanonicalCase[], observations: ReadonlyMap<string, string>): ManifestCase[] {
  return cases
    .map((c) => ({ id: c.id, features: c.features, observation: observations.get(c.id) ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Writes the manifest, one case per line so a changed case shows as a one-line diff. */
export async function writeManifest(projectDir: string, manifest: Manifest): Promise<void> {
  const file = manifestPath(projectDir);
  await mkdir(join(projectDir, '.port-anything'), { recursive: true });
  const { cases, ...head } = ManifestSchema.parse(manifest);
  const lines = cases.map((c, i) => `    ${JSON.stringify(c)}${i < cases.length - 1 ? ',' : ''}`);
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const text = `${headJson},\n  "cases": [${lines.length === 0 ? ']' : `\n${lines.join('\n')}\n  ]`}\n}\n`;
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

/** The project's manifest, or undefined when there is none. One that doesn't parse is a `ConfigError`. */
export async function readManifest(projectDir: string): Promise<Manifest | undefined> {
  const file = manifestPath(projectDir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`Cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const manifest = ManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    const problems = manifest.error.issues.map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(top level)'}: ${issue.message}`);
    throw new ConfigError([`${file} is not a manifest this version understands:`, ...problems].join('\n'));
  }
  return manifest.data;
}

export interface ObservationHashOptions {
  normalizers: readonly NormalizerSpec[];
  /** The case's features, for normalizers scoped by feature. */
  features: readonly string[];
  context: SideContext;
  store: BlobStore;
}

/**
 * Hash of an observation after the normalizers: its exit status, signal, timeout flag, output and
 * file changes, not its timings, which differ on every run.
 */
export async function observationHash(observation: Observation, options: ObservationHashOptions): Promise<string> {
  const side = { observation, context: options.context };
  const { reference: o } = await normalizePair({ normalizers: options.normalizers, features: options.features, reference: side, candidate: side, store: options.store });
  const json = canonicalJson({ exit: o.exit, signal: o.signal, timeout: o.timeout, stdout: o.stdout, stderr: o.stderr, fs: o.fs });
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

export type ObserveReferenceOptions = Omit<RunCasesOptions, 'candidates' | 'onCase' | 'compare' | 'rerun'>;

/** Runs the reference once on each case and returns the hash of each normalized observation, by case ID. */
export async function referenceObservationHashes(options: ObserveReferenceOptions): Promise<Map<string, string>> {
  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  const pinOptions = options.programName === undefined ? {} : { name: options.programName };
  const { name, sides } = await pinPrograms(join(workDir, 'programs'), [options.reference], pinOptions);
  const context = await sideContexts(workDir, [options.reference], name, sides);
  const containers = openContainers(options, workDir);
  const observeOptions = { ...options, ...(containers === undefined ? {} : { containers }) };
  const concurrency = options.concurrency ?? (options.sandbox.kind === 'container' ? defaultContainerConcurrency(1, options.sandbox.cpus) : defaultConcurrency());
  const hashes = await mapPool(options.cases, concurrency, async (c, _index, slot) => {
    // In container mode the case directory's parent is a tmpfs emptied after each case.
    const caseDir = join(workDir, `slot-${slot}`, 'case');
    const observation = await observeCase(c, caseDir, name, sides[0]!, observeOptions);
    return observationHash(observation, { normalizers: options.normalizers ?? [], features: c.features, context: context(0, caseDir), store: options.store });
  }).finally(() => containers?.close());
  return new Map(options.cases.map((c, i) => [c.id, hashes[i]!]));
}

/** One way the project no longer matches its manifest. */
export type ManifestProblem =
  | { kind: 'generator'; frozen: Manifest['generator']; now: Manifest['generator'] }
  | { kind: 'normalizers' }
  | { kind: 'missing-case'; case: string }
  | { kind: 'added-case'; case: string }
  | { kind: 'features'; case: string; frozen: string[]; now: string[] }
  | { kind: 'observation'; case: string };

export interface ManifestState {
  generator: Manifest['generator'];
  normalizers: Manifest['normalizers'];
  cases: readonly ManifestCase[];
  fingerprint: Fingerprint;
}

export interface ManifestCheck {
  problems: ManifestProblem[];
  /** Fingerprint fields that differ from the manifest's; none means the check is authoritative. */
  fingerprint: FingerprintField[];
}

/**
 * Compares the project as it is now with its manifest: the generator settings, the normalizers,
 * the set of cases and their features, and the hash of each observation the manifest has (a
 * flaky-reference case has none, so only its presence is checked).
 */
export function checkManifest(manifest: Manifest, now: ManifestState): ManifestCheck {
  const problems: ManifestProblem[] = [];
  if (canonicalJson(manifest.generator) !== canonicalJson(now.generator)) problems.push({ kind: 'generator', frozen: manifest.generator, now: now.generator });
  if (canonicalJson(manifest.normalizers) !== canonicalJson(now.normalizers)) problems.push({ kind: 'normalizers' });
  const current = new Map(now.cases.map((c) => [c.id, c]));
  for (const frozen of manifest.cases) {
    const c = current.get(frozen.id);
    if (c === undefined) {
      problems.push({ kind: 'missing-case', case: frozen.id });
      continue;
    }
    if (canonicalJson(frozen.features) !== canonicalJson(c.features)) problems.push({ kind: 'features', case: frozen.id, frozen: frozen.features, now: c.features });
    if (frozen.observation !== null && frozen.observation !== c.observation) problems.push({ kind: 'observation', case: frozen.id });
  }
  const frozenIds = new Set(manifest.cases.map((c) => c.id));
  for (const c of now.cases) if (!frozenIds.has(c.id)) problems.push({ kind: 'added-case', case: c.id });
  return { problems, fingerprint: fingerprintDifferences(manifest.fingerprint, now.fingerprint) };
}

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { COMPARED_FIELDS } from './compare.js';
import type { BlobStore } from './blob-store.js';
import { InlineContentSchema, inlineContent, type InlineContent } from './committed-cases.js';
import { ConfigError } from './config.js';
import { DIFF_SHAPES } from './diff-shape.js';
import { CaseIdSchema, type CanonicalCase } from './model.js';

/**
 * A run ID: the UTC time the run was saved, to the second, and 4 random hex digits so that runs
 * saved in the same second differ. IDs sort in time order, to the second.
 */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** Where saved runs live, `.port-anything/runs/` (git-ignored); one directory per run ID. */
export function runsDir(projectDir: string): string {
  return join(projectDir, '.port-anything', 'runs');
}

export const RUN_FILE = 'run.json';

export function newRunId(now: Date = new Date(), random: Buffer = randomBytes(2)): string {
  const [date, time] = now.toISOString().split('T') as [string, string];
  return `${date.replaceAll('-', '')}-${time.slice(0, 8).replaceAll(':', '')}-${random.toString('hex').slice(0, 4).padStart(4, '0')}`;
}

const SavedClusterSchema = z.object({
  /** Its number in the run, from 1, in the order the run lists clusters. */
  cluster: z.number().int().positive(),
  /** The candidate it belongs to, from 1, as in `candidate_commands`. */
  candidate: z.number().int().positive(),
  signature: z.object({
    fields: z.array(z.enum(COMPARED_FIELDS)).min(1),
    shapes: z.array(z.object({ field: z.enum(COMPARED_FIELDS), shape: z.enum(DIFF_SHAPES), detail: z.string().optional() })).min(1),
  }),
  /** Its cases' features with how many cases carry each (not part of the signature). */
  features: z.array(z.object({ feature: z.string().min(1), cases: z.number().int().positive() })),
  size: z.number().int().positive(),
  weight: z.number().nonnegative(),
  cases: z.array(CaseIdSchema).min(1),
});

export type SavedCluster = z.infer<typeof SavedClusterSchema>;

/**
 * What `.port-anything/runs/<run-id>/run.json` holds: the fields below, which addressing a cluster
 * needs, and whatever else the command that saved it reported (kept as is).
 */
export const RunRecordSchema = z
  .looseObject({
    version: z.literal(1),
    run_id: z.string().regex(RUN_ID_PATTERN),
    /** When it was saved, ISO 8601 with milliseconds. */
    created: z.iso.datetime(),
    /**
     * The part of the corpus it ran, when not the whole: `cluster` is the address it re-ran;
     * `smoke` is a smoke subset (see `smokeSubset`) of a corpus of `corpus` cases, with the open
     * clusters of run `from` (none when there was no run yet) and how many cases each part added;
     * `feature` the cases of one feature; `cases` the cases given by ID.
     */
    subset: z
      .union([
        z.object({ cluster: z.string() }),
        z.object({ feature: z.string().min(1) }),
        z.object({ cases: z.array(CaseIdSchema).min(1) }),
        z.object({
          smoke: z.object({
            from: z.string().regex(RUN_ID_PATTERN).nullable(),
            corpus: z.number().int().nonnegative(),
            clusters: z.number().int().nonnegative(),
            per_feature: z.number().int().nonnegative(),
            passing: z.number().int().nonnegative(),
          }),
        }),
      ])
      .nullable(),
    /** Each candidate as given in the config or on the command line. */
    candidate_commands: z.array(z.union([z.string().min(1), z.array(z.string()).min(1)])).min(1),
    clusters: z.array(SavedClusterSchema),
  })
  .superRefine((run, ctx) => {
    for (const [i, c] of run.clusters.entries()) {
      if (c.cluster !== i + 1) ctx.addIssue({ code: 'custom', path: ['clusters', i, 'cluster'], message: `must be ${i + 1}` });
      if (c.candidate > run.candidate_commands.length) ctx.addIssue({ code: 'custom', path: ['clusters', i, 'candidate'], message: 'no such candidate' });
      if (c.size !== c.cases.length) ctx.addIssue({ code: 'custom', path: ['clusters', i, 'size'], message: 'must be the number of cases' });
    }
  });

export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * Saves a run under a new run ID and returns it as saved. The directory is created exclusively,
 * and `run.json` written next to its final name then renamed, so a reader never sees half a run.
 */
export async function saveRun(projectDir: string, run: Omit<RunRecord, 'version' | 'run_id' | 'created'>, now: Date = new Date()): Promise<RunRecord> {
  const dir = runsDir(projectDir);
  await mkdir(dir, { recursive: true });
  for (;;) {
    const runId = newRunId(now);
    try {
      await mkdir(join(dir, runId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    const record = RunRecordSchema.parse({ ...run, version: 1, run_id: runId, created: now.toISOString() });
    const file = join(dir, runId, RUN_FILE);
    await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
    return record;
  }
}

/** Reads a saved run. A missing or damaged run is a `ConfigError` (exit 3). */
export async function loadRun(projectDir: string, runId: string): Promise<RunRecord> {
  if (!RUN_ID_PATTERN.test(runId)) throw new ConfigError(`"${runId}" is not a run ID (they look like ${newRunId(new Date(0), Buffer.from('a1b2', 'hex'))}).`);
  let raw: string;
  try {
    raw = await readFile(join(runsDir(projectDir), runId, RUN_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`No run ${runId} in .port-anything/runs/.`);
    throw e;
  }
  let parsed: ReturnType<typeof RunRecordSchema.safeParse>;
  try {
    parsed = RunRecordSchema.safeParse(JSON.parse(raw));
  } catch (e) {
    throw new ConfigError(`Run ${runId} is damaged: ${(e as Error).message}`);
  }
  if (!parsed.success) throw new ConfigError(`Run ${runId} is damaged: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (parsed.data.run_id !== runId) throw new ConfigError(`Run ${runId} is damaged: it says it is run ${parsed.data.run_id}.`);
  return parsed.data;
}

/**
 * The latest saved run of the whole corpus (a run of a subset, such as one cluster, doesn't
 * count), or undefined when there is none. Runs saved in the same second are told apart by their
 * `created` time; a run still being written is skipped.
 */
export async function latestRun(projectDir: string): Promise<RunRecord | undefined> {
  let ids: string[];
  try {
    ids = (await readdir(runsDir(projectDir))).filter((id) => RUN_ID_PATTERN.test(id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  ids.sort().reverse();
  let best: RunRecord | undefined;
  for (const id of ids) {
    // IDs only order runs to the second: once one is found, only that second's runs can be later.
    if (best !== undefined && id.slice(0, 15) !== best.run_id.slice(0, 15)) break;
    let run: RunRecord;
    try {
      run = await loadRun(projectDir, id);
    } catch (e) {
      if (e instanceof ConfigError) continue;
      throw e;
    }
    if (run.subset !== null) continue;
    if (best === undefined || run.created > best.created || (run.created === best.created && run.run_id > best.run_id)) best = run;
  }
  return best;
}

/**
 * The runs saved after `run` (by their `created` time, then run ID), oldest first, subset runs
 * included; a damaged run or one still being written is skipped.
 */
export async function runsAfter(projectDir: string, run: Pick<RunRecord, 'run_id' | 'created'>): Promise<RunRecord[]> {
  let ids: string[];
  try {
    ids = (await readdir(runsDir(projectDir))).filter((id) => RUN_ID_PATTERN.test(id) && id.slice(0, 15) >= run.run_id.slice(0, 15));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const later: RunRecord[] = [];
  for (const id of ids) {
    try {
      const r = await loadRun(projectDir, id);
      if (r.created > run.created || (r.created === run.created && r.run_id > run.run_id)) later.push(r);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
    }
  }
  return later.sort((a, b) => (a.created === b.created ? (a.run_id < b.run_id ? -1 : 1) : a.created < b.created ? -1 : 1));
}

export interface ClusterAddress {
  /** Absent for the latest run. */
  runId?: string;
  cluster: number;
}

/** Reads `<n>` or `<run-id>/<n>`. */
export function parseClusterAddress(text: string): ClusterAddress {
  const match = /^(?:([^/]+)\/)?([1-9]\d*)$/.exec(text);
  if (match === null || (match[1] !== undefined && !RUN_ID_PATTERN.test(match[1]))) {
    throw new ConfigError(`"${text}" is not a cluster: give its number, or <run-id>/<number> for a run other than the latest.`);
  }
  return { ...(match[1] === undefined ? {} : { runId: match[1] }), cluster: Number(match[2]) };
}

export interface ResolvedCluster {
  run: RunRecord;
  cluster: SavedCluster;
  /** `<run-id>/<n>`, with the run ID filled in. */
  address: string;
}

/**
 * Finds the cluster an address names: in the given run, or else in the latest run of the whole
 * corpus. Cluster numbers only mean something within their run.
 */
export async function resolveCluster(projectDir: string, address: string): Promise<ResolvedCluster> {
  const { runId, cluster: n } = parseClusterAddress(address);
  const run = runId === undefined ? await latestRun(projectDir) : await loadRun(projectDir, runId);
  if (run === undefined) throw new ConfigError('No saved run yet: run port-anything run first, then address its clusters.');
  const cluster = run.clusters[n - 1];
  if (cluster === undefined) {
    const has = run.clusters.length === 0 ? 'has no clusters' : run.clusters.length === 1 ? 'has 1 cluster' : `has clusters 1 to ${run.clusters.length}`;
    throw new ConfigError(`Run ${run.run_id} ${has}, so there is no cluster ${n}.`);
  }
  return { run, cluster, address: `${run.run_id}/${n}` };
}

/** A case written out with its content inline, as in committed case files (see `inlineCase`). */
const InlineCaseSchema = z.strictObject({
  id: CaseIdSchema,
  argv: z.array(z.string()),
  stdin: InlineContentSchema.nullable(),
  env: z.record(z.string(), z.string()),
  fixtures: z.record(z.string(), InlineContentSchema),
});

export type InlineCase = z.infer<typeof InlineCaseSchema>;

/** What `.port-anything/runs/<run-id>/repros/<n>.json` holds: cluster n's minimized repro. */
export const ReproRecordSchema = z.strictObject({
  version: z.literal(1),
  run_id: z.string().regex(RUN_ID_PATTERN),
  cluster: z.number().int().positive(),
  /** The cluster's case it was minimized from. */
  source: CaseIdSchema,
  /** Whether that case still showed the cluster's signature; when not, `case` is it, unminimized. */
  reproduced: z.boolean(),
  /** Runs made, and the budget they had; `exhausted` when the budget ran out before a 1-minimal case. */
  runs: z.number().int().nonnegative(),
  max_runs: z.number().int().positive(),
  exhausted: z.boolean(),
  /** When it was saved, ISO 8601 with milliseconds. */
  created: z.iso.datetime(),
  case: InlineCaseSchema,
});

export type ReproRecord = z.infer<typeof ReproRecordSchema>;

/** A stored case with its stdin and fixtures read from the store and written inline. */
export async function inlineCase(c: CanonicalCase, store: BlobStore): Promise<InlineCase> {
  const fixtures: Record<string, InlineContent> = {};
  for (const [path, ref] of Object.entries(c.fixtures)) fixtures[path] = inlineContent(await store.get(ref));
  return { id: c.id, argv: c.argv, stdin: c.stdin === null ? null : inlineContent(await store.get(c.stdin)), env: c.env, fixtures };
}

/** Where a cluster's repro is saved, `.port-anything/runs/<run-id>/repros/<n>.json`. */
export function reproPath(projectDir: string, runId: string, cluster: number): string {
  return join(runsDir(projectDir), runId, 'repros', `${cluster}.json`);
}

/**
 * Saves a cluster's repro next to its run, replacing an earlier one; written next to its final
 * name then renamed, so a reader never sees half of it. The run must exist.
 */
export async function saveRepro(projectDir: string, repro: Omit<ReproRecord, 'version' | 'created'>, now: Date = new Date()): Promise<ReproRecord> {
  const run = await loadRun(projectDir, repro.run_id);
  if (run.clusters[repro.cluster - 1] === undefined) throw new ConfigError(`Run ${repro.run_id} has no cluster ${repro.cluster}.`);
  const record = ReproRecordSchema.parse({ version: 1, ...repro, created: now.toISOString() });
  const file = reproPath(projectDir, repro.run_id, repro.cluster);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
  return record;
}

/** A cluster's saved repro, or undefined when it has none yet. A damaged one is a `ConfigError` (exit 3). */
export async function loadRepro(projectDir: string, runId: string, cluster: number): Promise<ReproRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(reproPath(projectDir, runId, cluster), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  let parsed: ReturnType<typeof ReproRecordSchema.safeParse>;
  try {
    parsed = ReproRecordSchema.safeParse(JSON.parse(raw));
  } catch (e) {
    throw new ConfigError(`The repro of cluster ${runId}/${cluster} is damaged: ${(e as Error).message}`);
  }
  if (!parsed.success) throw new ConfigError(`The repro of cluster ${runId}/${cluster} is damaged: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (parsed.data.run_id !== runId || parsed.data.cluster !== cluster) throw new ConfigError(`The repro of cluster ${runId}/${cluster} is damaged: it says it is cluster ${parsed.data.run_id}/${parsed.data.cluster}.`);
  return parsed.data;
}

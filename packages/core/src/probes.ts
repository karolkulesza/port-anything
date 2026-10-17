import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InlineContentSchema } from './committed-cases.js';
import { ConfigError } from './config.js';
import { CaseIdSchema, RelativePathSchema } from './model.js';
import { RUN_ID_PATTERN, newRunId } from './runs.js';

/**
 * Where ad-hoc runs of the reference are saved, `.port-anything/probes/` (git-ignored): one file
 * per probe. Probes are never part of the corpus, the manifest or a run.
 */
export function probesDir(projectDir: string): string {
  return join(projectDir, '.port-anything', 'probes');
}

/** A probe ID looks like a run ID: the UTC time it was saved, to the second, and 4 random hex digits. */
export const PROBE_ID_PATTERN = RUN_ID_PATTERN;

/** Where a probe is saved, `.port-anything/probes/<probe-id>.json`. */
export function probePath(projectDir: string, probeId: string): string {
  return join(probesDir(projectDir), `${probeId}.json`);
}

/** What `.port-anything/probes/<probe-id>.json` holds: one invocation of the reference and what it did, content inline. */
export const ProbeRecordSchema = z.strictObject({
  version: z.literal(1),
  probe_id: z.string().regex(PROBE_ID_PATTERN),
  /** When it was saved, ISO 8601 with milliseconds. */
  created: z.iso.datetime(),
  /** The reference command, as configured. */
  reference: z.string(),
  /** The argv[0] it ran as. */
  program_name: z.string(),
  case: z.strictObject({
    id: CaseIdSchema,
    argv: z.array(z.string()),
    stdin: InlineContentSchema.nullable(),
    env: z.record(z.string(), z.string()),
    fixtures: z.record(z.string(), InlineContentSchema),
  }),
  observation: z.strictObject({
    exit: z.int().min(0).max(255).nullable(),
    signal: z.string().nullable(),
    timeout: z.boolean(),
    wall_ms: z.number().nonnegative(),
    stdout: InlineContentSchema,
    stderr: InlineContentSchema,
    fs: z.strictObject({
      created: z.record(RelativePathSchema, InlineContentSchema),
      modified: z.record(RelativePathSchema, InlineContentSchema),
      deleted: z.array(RelativePathSchema),
    }),
  }),
});

export type ProbeRecord = z.infer<typeof ProbeRecordSchema>;

/**
 * Saves a probe under a new probe ID and returns it as saved; written next to its final name then
 * renamed, so a reader never sees half of it.
 */
export async function saveProbe(projectDir: string, probe: Omit<ProbeRecord, 'version' | 'probe_id' | 'created'>, now: Date = new Date()): Promise<ProbeRecord> {
  const dir = probesDir(projectDir);
  await mkdir(dir, { recursive: true });
  for (;;) {
    const record = ProbeRecordSchema.parse({ version: 1, probe_id: newRunId(now), created: now.toISOString(), ...probe });
    const file = probePath(projectDir, record.probe_id);
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    try {
      // Fails when the ID is taken (link, unlike rename, never replaces), so two probes in one second both stay.
      await link(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
    return record;
  }
}

/** A saved probe. A missing or damaged one is a `ConfigError`. */
export async function loadProbe(projectDir: string, probeId: string): Promise<ProbeRecord> {
  if (!PROBE_ID_PATTERN.test(probeId)) throw new ConfigError(`"${probeId}" is not a probe ID.`);
  let raw: string;
  try {
    raw = await readFile(probePath(projectDir, probeId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`No probe ${probeId} in .port-anything/probes/.`);
    throw e;
  }
  let parsed: ReturnType<typeof ProbeRecordSchema.safeParse>;
  try {
    parsed = ProbeRecordSchema.safeParse(JSON.parse(raw));
  } catch (e) {
    throw new ConfigError(`Probe ${probeId} is damaged: ${(e as Error).message}`);
  }
  if (!parsed.success) throw new ConfigError(`Probe ${probeId} is damaged: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

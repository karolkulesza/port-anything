import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BaselineResult } from './baseline.js';
import { cacheDir } from './blob-store.js';
import { ConfigError } from './config.js';
import { CaseIdSchema } from './model.js';

/** Where `baseline` leaves its result for `run`, inside the (git-ignored) cache directory. */
export const BASELINE_RECORD_FILE = 'baseline.json';

const BaselineRecordSchema = z.strictObject({
  version: z.literal(1),
  repeats: z.number().int().min(2),
  /** Cases whose reference output varies between runs; `run` leaves them out and lists them. */
  flaky_reference: z.array(z.strictObject({ case: CaseIdSchema, fields: z.array(z.string().min(1)).min(1) })),
});

export type BaselineRecord = z.output<typeof BaselineRecordSchema>;

/** What `run` needs to know from a baseline. */
export function baselineRecord(result: BaselineResult): BaselineRecord {
  return {
    version: 1,
    repeats: result.repeats,
    flaky_reference: result.cases.filter((c) => c.status === 'flaky-reference').map((c) => ({ case: c.caseId, fields: c.unstable })),
  };
}

export async function writeBaselineRecord(projectDir: string, record: BaselineRecord): Promise<void> {
  const dir = cacheDir(projectDir);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${BASELINE_RECORD_FILE}.${randomBytes(6).toString('hex')}`);
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, join(dir, BASELINE_RECORD_FILE));
}

/** The project's last baseline, or undefined when there is none. An unreadable record is a `ConfigError`. */
export async function readBaselineRecord(projectDir: string): Promise<BaselineRecord | undefined> {
  const file = join(cacheDir(projectDir), BASELINE_RECORD_FILE);
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
  } catch {
    parsed = undefined;
  }
  const record = BaselineRecordSchema.safeParse(parsed);
  if (!record.success) throw new ConfigError(`${file} is not a baseline this version understands; run port-anything baseline again.`);
  return record.data;
}

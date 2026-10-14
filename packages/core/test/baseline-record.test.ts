import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_RECORD_FILE, baselineRecord, readBaselineRecord, writeBaselineRecord } from '../src/baseline-record.js';
import type { BaselineResult, CaseBaseline } from '../src/baseline.js';
import { cacheDir } from '../src/blob-store.js';
import { ConfigError } from '../src/config.js';

const id = (c: string) => `sha256:${c.repeat(64)}`;
const result = (cases: Partial<CaseBaseline>[]): BaselineResult => ({
  programName: 'tool',
  repeats: 3,
  proposals: [],
  cases: cases.map((c) => ({ caseId: id('0'), observations: [], varied: [], fixes: [], unstable: [], status: 'stable', ...c })),
});

describe('baseline record', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pa-baseline-record-'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('keeps the flaky-reference cases with the fields that vary', () => {
    const record = baselineRecord(
      result([
        { caseId: id('a') },
        { caseId: id('b'), status: 'normalized', varied: ['stdout'] },
        { caseId: id('c'), status: 'flaky-reference', varied: ['exit', 'stdout'], unstable: ['exit', 'stdout'] },
      ]),
    );
    expect(record).toEqual({ version: 1, repeats: 3, flaky_reference: [{ case: id('c'), fields: ['exit', 'stdout'] }] });
  });

  it('round-trips through the cache directory, and is absent before the first baseline', async () => {
    expect(await readBaselineRecord(project)).toBeUndefined();
    const record = { version: 1 as const, repeats: 4, flaky_reference: [{ case: id('d'), fields: ['stderr'] }] };
    await writeBaselineRecord(project, record);
    expect(await readBaselineRecord(project)).toEqual(record);
  });

  it('refuses a record it does not understand, saying how to fix it', async () => {
    mkdirSync(cacheDir(project), { recursive: true });
    for (const content of ['not json', '{"version": 2, "repeats": 3, "flaky_reference": []}']) {
      writeFileSync(join(cacheDir(project), BASELINE_RECORD_FILE), content);
      const error = await readBaselineRecord(project).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(/run port-anything baseline again/);
    }
  });
});

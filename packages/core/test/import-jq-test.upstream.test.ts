import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import type { ImportResult } from '../src/import.js';
import { importCases } from '../src/importers.js';

// jq's own test suite, fetched at test time and never committed. Pinned to a release, with the
// content hashes checked so a moved tag shows up as a failure instead of silently changed counts.
// Set PA_OFFLINE=1 to skip this file without network access.
const JQ_TAG = 'jq-1.8.1';
const FILES = {
  'tests/jq.test': 'f182d4c772688fd7fabceb3b3338ad48427f072c1dae9622d9177cb031c16d41',
  COPYING: 'ad2b4a266b2268939c1446979759706077421cf906a203aa188c6f396e8cfd74',
};

let dir: string;
let result: ImportResult;

async function fetchPinned(path: string, sha256: string): Promise<Buffer> {
  const url = `https://raw.githubusercontent.com/jqlang/jq/${JQ_TAG}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`${url} changed: sha256 ${actual}, expected ${sha256}`);
  return bytes;
}

describe.skipIf(process.env.PA_OFFLINE === '1')(`importing jq's tests/jq.test (${JQ_TAG})`, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-jq-upstream-'));
    await mkdir(join(dir, 'jq', 'tests'), { recursive: true });
    for (const [path, sha256] of Object.entries(FILES)) await writeFile(join(dir, 'jq', path), await fetchPinned(path, sha256));
    result = await importCases({ kind: 'jq-test', path: join(dir, 'jq', 'tests', 'jq.test') }, new BlobStore(join(dir, 'cache')));
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('yields hundreds of cases, all with origin: imported', () => {
    expect(result.cases.length).toBeGreaterThan(500);
    expect(result.cases.every((c) => c.case.origin === 'imported')).toBe(true);
    expect(new Set(result.cases.map((c) => c.case.id)).size).toBe(result.cases.length);
    expect(result.skipped).toEqual([]);
  });

  it('records the source license, detected from COPYING (MIT, plus BSD for bundled code)', () => {
    expect(result.license).toEqual({
      licenses: ['BSD-2-Clause', 'MIT'],
      category: 'permissive',
      method: 'detected',
      files: [join(dir, 'jq', 'COPYING')],
    });
  });

  it('maps programs to argv and inputs to stdin', () => {
    const negative = result.cases.find((c) => c.case.argv.join(' ') === '-- -1');
    expect(negative?.case.stdin).toBe(blobRef('null\n'));
    expect(negative?.expected).toEqual({ kind: 'output', lines: ['-1'] });
    const failing = result.cases.filter((c) => c.expected?.kind === 'error');
    expect(failing.length).toBeGreaterThanOrEqual(10);
    expect(failing.every((c) => c.case.stdin === null)).toBe(true);
  });
});

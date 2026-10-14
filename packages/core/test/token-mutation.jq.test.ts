import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateByteMutants } from '../src/byte-mutation.js';
import { buildTokenDictionary } from '../src/token-dictionary.js';
import { generateTokenMutants } from '../src/token-mutation.js';
import { JQ_FILTERS } from './fixtures/jq-filters.js';

// Measures how many mutated jq filters still parse. jq exits 3 on a compile error; anything else
// (a runtime error, a timeout on an endless filter) means the filter parsed.
const jqHelp = spawnSync('jq', ['--help'], { encoding: 'utf8' });
const haveJq = jqHelp.status === 0;
const COUNT = 400;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-jq-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function parses(file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('jq', ['-n', '-f', file], { stdio: 'ignore', timeout: 2000 });
    child.on('error', reject);
    child.on('close', (code) => resolve(code !== 3));
  });
}

async function parseRate(filters: readonly Uint8Array[], tag: string): Promise<number> {
  const results: boolean[] = [];
  for (let i = 0; i < filters.length; i += 16) {
    const batch = filters.slice(i, i + 16).map(async (bytes, j) => {
      const file = join(dir, `${tag}-${i + j}.jq`);
      await writeFile(file, bytes);
      return parses(file);
    });
    results.push(...(await Promise.all(batch)));
  }
  return results.filter(Boolean).length / filters.length;
}

const percent = (r: number) => `${(r * 100).toFixed(1)}%`;

describe.skipIf(!haveJq)('token mutation on jq filters', () => {
  it('every seed parses', { timeout: 30_000 }, async () => {
    expect(await parseRate(JQ_FILTERS.map((f) => Buffer.from(f)), 'seed')).toBe(1);
  });

  it('keeps at least half of the mutated filters parseable, well above byte mutation', { timeout: 60_000 }, async () => {
    const dictionary = buildTokenDictionary({ help: jqHelp.stdout, seeds: JQ_FILTERS });
    const tokens = generateTokenMutants(JQ_FILTERS, { dictionary, count: COUNT, seed: 1, generator: 'v1' });
    const bytes = generateByteMutants(JQ_FILTERS.map((f) => Buffer.from(f)), { count: COUNT, seed: 1, generator: 'v1' });
    const tokenRate = await parseRate(tokens.map((m) => Buffer.from(m.text)), 'token');
    const byteRate = await parseRate(bytes.map((m) => m.bytes), 'byte');
    const ops = new Map<string, number>();
    for (const m of tokens) ops.set(m.op, (ops.get(m.op) ?? 0) + 1);
    const byOp = [...ops].map(([op, n]) => `${op} ${n}`).join(', ');
    console.log(`jq filters parsing after one mutation (${COUNT} each, ${jqHelp.stdout.split('\n')[0]?.trim() ?? 'jq'}): token ${percent(tokenRate)} [${byOp}], byte ${percent(byteRate)}`);
    expect(tokenRate).toBeGreaterThanOrEqual(0.5);
    expect(tokenRate).toBeGreaterThan(byteRate);
  });
});

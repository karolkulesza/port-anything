import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, PROBE_ID_PATTERN, caseId, loadProbe, probePath, probesDir, saveProbe, type ProbeRecord } from '../src/index.js';

const probe = (): Omit<ProbeRecord, 'version' | 'probe_id' | 'created'> => ({
  reference: './bin/tool',
  program_name: 'tool',
  case: { id: caseId({ argv: ['-n'], origin: 'recorded' }), argv: ['-n'], stdin: null, env: {}, fixtures: {} },
  observation: { exit: 0, signal: null, timeout: false, wall_ms: 3, stdout: 'x\n', stderr: '', fs: { created: { out: { base64: '/w==' } }, modified: {}, deleted: [] } },
});

describe('probes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-probes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves a probe under .port-anything/probes/ and reads it back', async () => {
    const saved = await saveProbe(dir, probe(), new Date('2026-10-16T08:00:00.123Z'));
    expect(saved.probe_id).toMatch(PROBE_ID_PATTERN);
    expect(saved.probe_id.startsWith('20261016-080000-')).toBe(true);
    expect(probePath(dir, saved.probe_id)).toBe(join(dir, '.port-anything', 'probes', `${saved.probe_id}.json`));
    expect(await loadProbe(dir, saved.probe_id)).toEqual(saved);
  });

  it('keeps two probes saved in the same second, and leaves no temporary file', async () => {
    const now = new Date('2026-10-16T08:00:00.000Z');
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await saveProbe(dir, probe(), now)).probe_id);
    expect(ids.size).toBe(20);
    expect(readdirSync(probesDir(dir)).filter((f) => !f.endsWith('.json'))).toEqual([]);
  });

  it('reports a missing or damaged probe as a config error', async () => {
    await expect(loadProbe(dir, 'nope')).rejects.toThrow(ConfigError);
    await expect(loadProbe(dir, '20261016-080000-abcd')).rejects.toThrow('No probe 20261016-080000-abcd');
    const saved = await saveProbe(dir, probe());
    writeFileSync(probePath(dir, saved.probe_id), '{');
    await expect(loadProbe(dir, saved.probe_id)).rejects.toThrow(/is damaged/);
  });
});

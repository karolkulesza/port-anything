import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { RUN_FILE, latestRun, loadRun, newRunId, parseClusterAddress, resolveCluster, runsDir, saveRun, type RunRecord } from '../src/runs.js';

const ID_A = `sha256:${'a'.repeat(64)}`;
const ID_B = `sha256:${'b'.repeat(64)}`;

const cluster = (n: number, candidate: number, cases: string[]) => ({
  cluster: n,
  candidate,
  signature: { fields: ['stdout' as const], shapes: [{ field: 'stdout' as const, shape: 'number-value' as const }] },
  features: [{ feature: 'opt.l', cases: cases.length }],
  size: cases.length,
  weight: 0.5,
  cases,
});
const run = (over: Partial<RunRecord> = {}) => ({
  subset: null,
  candidate_commands: ['./good', ['./bad', '--x']],
  clusters: [cluster(1, 2, [ID_A, ID_B]), cluster(2, 2, [ID_B])],
  ...over,
});

describe('newRunId', () => {
  it('is the UTC time to the second and 4 hex digits, so IDs sort in time order', () => {
    expect(newRunId(new Date('2026-10-14T19:02:03.456Z'), Buffer.from('a1b2', 'hex'))).toBe('20261014-190203-a1b2');
    expect(newRunId(new Date('2026-01-02T03:04:05Z'), Buffer.from([0, 7]))).toBe('20260102-030405-0007');
  });
});

describe('saved runs', () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-runs-')));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('saves a run under a new ID, keeping the extra fields, and loads it back', async () => {
    const saved = await saveRun(project, { ...run(), cases: 3 }, new Date('2026-10-14T19:02:03.456Z'));
    expect(saved.run_id).toMatch(/^20261014-190203-[0-9a-f]{4}$/);
    expect(saved).toMatchObject({ version: 1, created: '2026-10-14T19:02:03.456Z', cases: 3 });
    expect(readdirSync(join(runsDir(project), saved.run_id))).toEqual([RUN_FILE]);
    expect(await loadRun(project, saved.run_id)).toEqual(saved);
  });

  it('gives runs saved in the same second different IDs', async () => {
    const now = new Date('2026-10-14T19:02:03Z');
    const ids = await Promise.all(Array.from({ length: 20 }, () => saveRun(project, run(), now).then((r) => r.run_id)));
    expect(new Set(ids).size).toBe(20);
  });

  it('refuses a run whose clusters are not numbered in order or name a missing candidate', async () => {
    await expect(saveRun(project, run({ clusters: [cluster(2, 1, [ID_A])] }))).rejects.toThrow(/must be 1/);
    await expect(saveRun(project, run({ clusters: [cluster(1, 3, [ID_A])] }))).rejects.toThrow(/no such candidate/);
  });

  it('says when a run is missing, damaged or not a run ID (config errors)', async () => {
    await expect(loadRun(project, '20261014-190203-a1b2')).rejects.toThrow(new ConfigError('No run 20261014-190203-a1b2 in .port-anything/runs/.'));
    await expect(loadRun(project, '../x')).rejects.toThrow(/"\.\.\/x" is not a run ID \(they look like 19700101-000000-a1b2\)/);
    const dir = join(runsDir(project), '20261014-190203-a1b2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RUN_FILE), '{');
    await expect(loadRun(project, '20261014-190203-a1b2')).rejects.toThrow(/Run 20261014-190203-a1b2 is damaged/);
    const other = await saveRun(project, run());
    writeFileSync(join(dir, RUN_FILE), readFileSync(join(runsDir(project), other.run_id, RUN_FILE)));
    await expect(loadRun(project, '20261014-190203-a1b2')).rejects.toThrow(/it says it is run/);
  });

  describe('latestRun', () => {
    it('is undefined before any run', async () => {
      expect(await latestRun(project)).toBeUndefined();
    });

    it('is the latest run of the whole corpus, skipping subset runs and runs still being written', async () => {
      const first = await saveRun(project, run(), new Date('2026-10-14T19:00:00Z'));
      const second = await saveRun(project, run(), new Date('2026-10-14T19:05:00Z'));
      await saveRun(project, run({ subset: { cluster: `${second.run_id}/1` } }), new Date('2026-10-14T19:06:00Z'));
      mkdirSync(join(runsDir(project), '20261014-190700-ffff'));
      expect((await latestRun(project))?.run_id).toBe(second.run_id);
      expect(first.run_id < second.run_id).toBe(true);
    });

    it('tells runs of the same second apart by their saved time', async () => {
      const runs = [];
      for (const ms of [100, 900, 500]) runs.push(await saveRun(project, run(), new Date(`2026-10-14T19:00:00.${ms}Z`)));
      expect((await latestRun(project))?.run_id).toBe(runs[1]!.run_id);
    });
  });

  describe('cluster addresses', () => {
    it('reads <n> and <run-id>/<n>', () => {
      expect(parseClusterAddress('3')).toEqual({ cluster: 3 });
      expect(parseClusterAddress('20261014-190203-a1b2/12')).toEqual({ runId: '20261014-190203-a1b2', cluster: 12 });
      for (const bad of ['0', '01', '-1', 'x', '20261014-190203-a1b2/', 'run/3', '1/2/3', '']) {
        expect(() => parseClusterAddress(bad), bad).toThrow(ConfigError);
      }
    });

    it('resolves a number in the latest run, or in the run named', async () => {
      const old = await saveRun(project, run({ clusters: [cluster(1, 1, [ID_A])] }), new Date('2026-10-14T19:00:00Z'));
      const latest = await saveRun(project, run(), new Date('2026-10-14T19:05:00Z'));
      const two = await resolveCluster(project, '2');
      expect(two.address).toBe(`${latest.run_id}/2`);
      expect(two.cluster.cases).toEqual([ID_B]);
      expect(two.run.candidate_commands[two.cluster.candidate - 1]).toEqual(['./bad', '--x']);
      const one = await resolveCluster(project, `${old.run_id}/1`);
      expect([one.address, one.cluster.candidate]).toEqual([`${old.run_id}/1`, 1]);
    });

    it('says when there is no run yet, or no such cluster in the run', async () => {
      await expect(resolveCluster(project, '1')).rejects.toThrow(/No saved run yet/);
      const r = await saveRun(project, run());
      await expect(resolveCluster(project, '3')).rejects.toThrow(new ConfigError(`Run ${r.run_id} has clusters 1 to 2, so there is no cluster 3.`));
      const none = await saveRun(project, run({ clusters: [] }), new Date(Date.now() + 1000));
      await expect(resolveCluster(project, '1')).rejects.toThrow(`Run ${none.run_id} has no clusters, so there is no cluster 1.`);
      await expect(resolveCluster(project, '20200101-000000-0000/1')).rejects.toThrow(/No run 20200101-000000-0000/);
    });
  });
});

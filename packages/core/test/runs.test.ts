import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { BlobStore } from '../src/blob-store.js';
import { canonicalCase } from '../src/model.js';
import {
  RUN_FILE,
  RunRecordSchema,
  inlineCase,
  latestRun,
  loadRepro,
  loadRun,
  newRunId,
  parseClusterAddress,
  resolveCluster,
  runsAfter,
  runsDir,
  saveRepro,
  saveRun,
  type RunRecord,
} from '../src/runs.js';

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

  describe('runsAfter', () => {
    it('lists the runs saved after a run, oldest first, skipping damaged ones', async () => {
      const first = await saveRun(project, run(), new Date('2026-10-14T19:00:00Z'));
      const c = await saveRun(project, run({ subset: { cluster: `${first.run_id}/1` } }), new Date('2026-10-14T19:07:00Z'));
      const b = await saveRun(project, run(), new Date('2026-10-14T19:05:00Z'));
      await saveRun(project, run(), new Date('2026-10-14T18:00:00Z'));
      mkdirSync(join(runsDir(project), '20261014-190800-ffff'));
      expect((await runsAfter(project, first)).map((r) => r.run_id)).toEqual([b.run_id, c.run_id]);
      expect(await runsAfter(project, c)).toEqual([]);
    });

    it('is empty without runs', async () => {
      expect(await runsAfter(project, { run_id: '20261014-190000-aaaa', created: '2026-10-14T19:00:00.000Z' })).toEqual([]);
    });
  });

  describe('latestRun', () => {
    it('is undefined before any run', async () => {
      expect(await latestRun(project)).toBeUndefined();
    });

    it('is the latest run of the whole corpus, skipping cluster and smoke runs and runs still being written', async () => {
      const first = await saveRun(project, run(), new Date('2026-10-14T19:00:00Z'));
      const second = await saveRun(project, run(), new Date('2026-10-14T19:05:00Z'));
      await saveRun(project, run({ subset: { cluster: `${second.run_id}/1` } }), new Date('2026-10-14T19:06:00Z'));
      const smoke = { smoke: { from: second.run_id, corpus: 40, clusters: 2, per_feature: 10, passing: 5 } };
      const third = await saveRun(project, run({ subset: smoke }), new Date('2026-10-14T19:06:30Z'));
      expect((await loadRun(project, third.run_id)).subset).toEqual(smoke);
      await saveRun(project, run({ subset: { feature: 'opt.n' } }), new Date('2026-10-14T19:06:40Z'));
      await saveRun(project, run({ subset: { cases: [run().clusters[0]!.cases[0]!] } }), new Date('2026-10-14T19:06:50Z'));
      mkdirSync(join(runsDir(project), '20261014-190700-ffff'));
      expect((await latestRun(project))?.run_id).toBe(second.run_id);
      expect(first.run_id < second.run_id).toBe(true);
    });

    it('keeps the feature or cases a subset run ran', async () => {
      const id = run().clusters[0]!.cases[0]!;
      const saved = await saveRun(project, run({ subset: { cases: [id] } }));
      expect((await loadRun(project, saved.run_id)).subset).toEqual({ cases: [id] });
      expect(() => RunRecordSchema.parse({ ...saved, subset: { feature: '' } })).toThrow();
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

describe('saved repros', () => {
  let project: string;
  let store: BlobStore;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-repros-')));
    store = new BlobStore(join(project, 'cache'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const repro = async (runId: string, n: number) => {
    const c = canonicalCase({ argv: ['-L', 'crlf.txt'], stdin: await store.put(Buffer.from([0xff, 0x00])), fixtures: { 'crlf.txt': await store.put('\r\n') }, origin: 'generated' });
    return { run_id: runId, cluster: n, source: ID_A, reproduced: true, runs: 17, max_runs: 200, exhausted: false, case: await inlineCase(c, store) };
  };

  it('writes the case inline, text as text and other bytes as base64', async () => {
    const saved = await saveRun(project, run());
    const r = await repro(saved.run_id, 2);
    expect(r.case).toMatchObject({ argv: ['-L', 'crlf.txt'], stdin: { base64: '/wA=' }, env: {}, fixtures: { 'crlf.txt': '\r\n' } });
  });

  it('saves a cluster repro next to its run and reads it back; none until saved', async () => {
    const saved = await saveRun(project, run());
    expect(await loadRepro(project, saved.run_id, 1)).toBeUndefined();
    const record = await saveRepro(project, await repro(saved.run_id, 1), new Date('2026-10-14T19:00:00Z'));
    expect(record).toMatchObject({ version: 1, run_id: saved.run_id, cluster: 1, created: '2026-10-14T19:00:00.000Z' });
    expect(readdirSync(join(runsDir(project), saved.run_id, 'repros'))).toEqual(['1.json']);
    expect(await loadRepro(project, saved.run_id, 1)).toEqual(record);
    expect(await loadRepro(project, saved.run_id, 2)).toBeUndefined();
    // Saving again replaces it.
    const again = await saveRepro(project, { ...(await repro(saved.run_id, 1)), runs: 3 });
    expect(await loadRepro(project, saved.run_id, 1)).toEqual(again);
  });

  it('refuses a repro for a run or cluster that does not exist', async () => {
    const saved = await saveRun(project, run());
    await expect(saveRepro(project, await repro(saved.run_id, 3))).rejects.toThrow(ConfigError);
    await expect(saveRepro(project, await repro('20260101-000000-abcd', 1))).rejects.toThrow(/No run/);
  });

  it('reports a damaged repro as a config error', async () => {
    const saved = await saveRun(project, run());
    const file = join(runsDir(project), saved.run_id, 'repros', '2.json');
    mkdirSync(join(runsDir(project), saved.run_id, 'repros'));
    writeFileSync(file, '{');
    await expect(loadRepro(project, saved.run_id, 2)).rejects.toThrow(/damaged/);
    const other = await saveRepro(project, await repro(saved.run_id, 1));
    writeFileSync(file, JSON.stringify(other));
    await expect(loadRepro(project, saved.run_id, 2)).rejects.toThrow(/says it is cluster .*\/1/);
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const TOOL = (variant: 'ref' | 'bad') => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  count) echo ${variant === 'bad' ? 4 : 3} ;;
  fail) echo "tool: no" >&2; exit ${variant === 'bad' ? 2 : 1} ;;
  crash) exit ${variant === 'bad' ? 3 : 0} ;;
esac
`;

describe('waive --from-cluster', () => {
  let project: string;
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-waive-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-bad'), TOOL('bad'), { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./bin/tool }\ncandidate: { cmd: ./bin/tool-bad }\n');
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    const cases = [
      { argv: ['echo', 'a'], features: ['opt.e'] },
      { argv: ['count', '-n'], features: ['opt.n'] },
      { argv: ['count', '-n', '-x'], features: ['opt.n', 'opt.x'] },
      { argv: ['fail'], features: ['error.usage'] },
      { argv: ['crash'], features: ['error.usage', 'opt.c'] },
    ];
    writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), cases.map((c) => JSON.stringify({ ...c, origin: 'recorded' })).join('\n'));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const runId = (stdout: string) => /^run (\S+)/m.exec(stdout)![1]!;

  it('prints waivers for a cluster of the latest run that, once pasted with a reason, waive its cases', async () => {
    const first = await run(['run', '--no-sandbox'], { cwd: project });
    expect(first.exitCode).toBe(1);
    // By weight: the counts of opt.n and opt.x (1/2 + 1/2 + 1), the crash (1/2 + 1), the usage error (1/2).
    expect(first.stdout).toContain('  cluster 1: 2 cases · stdout number-value · features opt.n (2), opt.x (1)\n');
    expect(first.stdout).toContain('  cluster 2: 1 case · exit 0 vs 3 · features error.usage (1), opt.c (1)\n');
    expect(first.stdout).toContain('  cluster 3: 1 case · exit 1 vs 2 · features error.usage (1)\n');

    const one = await run(['waive', '--from-cluster', `${runId(first.stdout)}/3`], { cwd: project });
    expect(one).toEqual({
      exitCode: 0,
      stdout: [
        `# Cluster ${runId(first.stdout)}/3: exit 1 vs 2 · features error.usage (1)`,
        '# Paste into port-anything/waivers.yaml, pick the category and write the reason.',
        // Waivers cover any exit status difference of the feature, so the crash in error.usage too.
        '# Warning: these would also waive fields of other clusters of this run: 2 (1 case).',
        '# Narrow them with feature: or regex: unless those are the same difference.',
        '- match: { feature: error.usage, field: exit, shape: exit-code }',
        '  category: intentional # intentional | reference-bug | platform',
        '  reason: ""',
        '',
      ].join('\n'),
      stderr: '',
    });
    const two = await run(['waive', '--from-cluster', '1'], { cwd: project });
    expect(two.stdout).toContain('# Its cases have several features: add feature: <name> to waive only one of them.\n- match: { field: stdout, shape: number-value }\n');
    expect(two.stdout).not.toContain('Warning');

    // Pasted as printed, the empty reason is refused.
    writeFileSync(join(project, 'port-anything', 'waivers.yaml'), one.stdout);
    const unreasoned = await run(['run', '--no-sandbox'], { cwd: project });
    expect(unreasoned.exitCode).toBe(3);
    expect(unreasoned.stderr).toContain('0.reason: must say why the divergence is accepted');

    writeFileSync(
      join(project, 'port-anything', 'waivers.yaml'),
      `${one.stdout.replace('reason: ""', 'reason: "exits 2 on purpose"')}${two.stdout.replace('reason: ""', 'reason: "counts the trailing line"')}`,
    );
    const waived = await run(['run', '--no-sandbox'], { cwd: project });
    // As warned, the crash is waived with the usage error.
    expect(waived.stdout).toContain('candidate 1 ./bin/tool-bad: 1 of 5 cases match, 4 waived\n');
    expect(waived.stdout).not.toContain('cluster 1');
    expect(waived.exitCode).toBe(0);
    rmSync(join(project, 'port-anything', 'waivers.yaml'));
  });

  it('exits 3 without a cluster, for a cluster it cannot find, or for an unknown option', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pa-cli-waive-'));
    try {
      expect(await run(['waive', '--from-cluster', '1'], { cwd: empty })).toEqual({
        exitCode: 3,
        stdout: '',
        stderr: 'port-anything waive: No saved run yet: run port-anything run first, then address its clusters.\n',
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect((await run(['waive'], { cwd: project })).stderr).toBe('port-anything waive: give the cluster to waive.\nUsage: port-anything waive --from-cluster [<run-id>/]<n>\n');
    expect((await run(['waive', '--from-cluster', '9'], { cwd: project })).stderr).toMatch(/^port-anything waive: Run \S+ has (no clusters|clusters 1 to 3), so there is no cluster 9\.\n$/);
    const unknown = await run(['waive', '--cluster', '1'], { cwd: project });
    expect(unknown).toMatchObject({ exitCode: 3, stdout: '' });
    expect(unknown.stderr).toMatch(/--cluster/);
  });
});

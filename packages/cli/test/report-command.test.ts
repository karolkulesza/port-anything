import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestRun, runsDir } from '@port-anything/core';
import { ReportJsonSchema } from '@port-anything/report';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

// Needs @port-anything/core and @port-anything/report built (`pnpm build`), like the other CLI tests.
const TOOL = (variant: 'ref' | 'count' | 'exit') => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  count) echo ${variant === 'count' ? 4 : 3} ;;
  cat) cat ;;
  fail) echo "tool: no" >&2; exit ${variant === 'exit' ? 2 : 1} ;;
esac
`;

describe('report', () => {
  let project: string;
  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-report-')));
    mkdirSync(join(project, 'bin'));
    writeFileSync(join(project, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-copy'), TOOL('ref'), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-count'), TOOL('count'), { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'tool-exit'), TOOL('exit'), { mode: 0o755 });
    writeFileSync(
      join(project, 'port-anything.yaml'),
      'version: 1\nprogram_name: tool\nreference: { cmd: ./bin/tool }\ncandidates: [{ cmd: ./bin/tool-copy }, { cmd: ./bin/tool-count }, { cmd: ./bin/tool-exit }]\ncorpus: { min_cases_per_feature: 1 }\n',
    );
    mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
    const cases = [
      { argv: ['echo', 'a b'], features: ['opt.e'] },
      { argv: ['count', '-n', 'a long argument that makes this case bigger'], features: ['opt.n'] },
      { argv: ['count', '-n'], features: ['opt.n'] },
      { argv: ['cat'], stdin: 'x <y>\n', features: [] },
      { argv: ['fail'], features: ['error.usage'] },
    ];
    writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), cases.map((c) => JSON.stringify({ ...c, origin: 'recorded' })).join('\n'));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('exits 3 before any run', async () => {
    expect(await run(['report'], { cwd: project })).toEqual({ exitCode: 3, stdout: '', stderr: 'port-anything report: No saved run of the whole corpus yet: run port-anything run first.\n' });
  });

  it('writes the latest run of a 3-candidate project as one offline page with the N-way matrix and repros (done when)', async () => {
    const ran = await run(['run', '--no-sandbox'], { cwd: project });
    expect(ran.exitCode).toBe(1);
    const runId = /^run (\S+)/m.exec(ran.stdout)![1]!;
    // A later run of one cluster doesn't replace the latest full run.
    expect((await run(['run', '--no-sandbox', '--cluster', '1'], { cwd: project })).exitCode).toBe(1);

    const result = await run(['report', '--html'], { cwd: project });
    expect(result).toEqual({ exitCode: 0, stdout: `report of run ${runId}: ./port-anything-report.html\n`, stderr: '' });
    const html = readFileSync(join(project, 'port-anything-report.html'), 'utf8');

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain(`run ${runId}`);
    expect(html).not.toMatch(/<script|<link|<img|@import|url\(|\b(?:src|href)\s*=|https?:\/\//i);
    const matrix = /<section id="matrix">[\s\S]*?<\/section>/.exec(html)![0];
    expect(matrix.match(/<th scope="col">candidate \d<br><code>[^<]*<\/code><\/th>/g)).toEqual([
      '<th scope="col">candidate 1<br><code>./bin/tool-copy</code></th>',
      '<th scope="col">candidate 2<br><code>./bin/tool-count</code></th>',
      '<th scope="col">candidate 3<br><code>./bin/tool-exit</code></th>',
    ]);
    expect(matrix).toContain('<tr><th scope="row"><code>opt.n</code></th><td class="num full">100.0% <span class="note">(2/2)</span></td><td class="num low">0.0% <span class="note">(0/2)</span></td><td class="num full">100.0% <span class="note">(2/2)</span></td></tr>');
    expect(matrix).toContain('<tr><th scope="row">headline (mean)</th><td class="num full"><strong>100.0%</strong></td><td class="num low"><strong>75.0%</strong></td><td class="num low"><strong>75.0%</strong></td></tr>');

    const clusters = /<section id="clusters">[\s\S]*?<\/section>/.exec(html)![0];
    expect(clusters).toContain('<h3>candidate 1 <code>./bin/tool-copy</code>: 0 clusters</h3>');
    // The smaller of the two opt.n cases is the repro.
    expect(clusters).toContain('<h3>cluster 1: 2 cases · stdout number-value</h3>');
    expect(clusters).toContain('<pre>$ tool count -n</pre>');
    expect(clusters).toContain('<h3>cluster 2: 1 case · exit 1 vs 2</h3>');
    expect(clusters).toContain('<pre>$ tool fail</pre>');
  });

  it('writes report.json, valid against its schema, and a badge per candidate whose text matches the headline (done when)', async () => {
    const runId = /<p class="meta">run (\S+)/.exec(readFileSync(join(project, 'port-anything-report.html'), 'utf8'))![1]!;
    const result = await run(['report', '--json', '--badge'], { cwd: project });
    expect(result).toEqual({
      exitCode: 0,
      stdout: `report of run ${runId}: ./port-anything-report.json, ./port-anything-badge.svg, ./port-anything-badge-2.svg, ./port-anything-badge-3.svg\n`,
      stderr: '',
    });

    const json = ReportJsonSchema.parse(JSON.parse(readFileSync(join(project, 'port-anything-report.json'), 'utf8')));
    expect(json.run_id).toBe(runId);
    expect(json.candidates.map((c) => [c.command, c.headline])).toEqual([
      ['./bin/tool-copy', 1],
      ['./bin/tool-count', 0.75],
      ['./bin/tool-exit', 0.75],
    ]);
    expect(json.clusters.map((k) => [k.candidate, k.description, k.size])).toEqual([
      [2, 'stdout number-value', 2],
      [3, 'exit 1 vs 2', 1],
    ]);

    // The headline row of the HTML report: 100.0%, 75.0%, 75.0%.
    const html = readFileSync(join(project, 'port-anything-report.html'), 'utf8');
    const headlines = [...html.matchAll(/<td class="num \w+"><strong>([^<]+)<\/strong><\/td>/g)].map((m) => m[1]);
    expect(headlines).toEqual(['100.0%', '75.0%', '75.0%']);
    for (const [i, file] of ['port-anything-badge.svg', 'port-anything-badge-2.svg', 'port-anything-badge-3.svg'].entries()) {
      const svg = readFileSync(join(project, file), 'utf8');
      const label = /aria-label="([^"]*)"/.exec(svg)![1];
      expect(label).toBe(`parity ${headlines[i]} · 4 features · 5 cases`);
      expect(label).toBe(json.candidates[i]!.badge);
    }
  });

  it('writes the page, the JSON and the badges without options', async () => {
    rmSync(join(project, 'port-anything-report.json'));
    rmSync(join(project, 'port-anything-badge-3.svg'));
    const result = await run(['report'], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/: \.\/port-anything-report\.html, \.\/port-anything-report\.json, \.\/port-anything-badge\.svg, \.\/port-anything-badge-2\.svg, \.\/port-anything-badge-3\.svg\n$/);
    expect(readFileSync(join(project, 'port-anything-badge-3.svg'), 'utf8')).toMatch(/^<svg /);
    expect(ReportJsonSchema.safeParse(JSON.parse(readFileSync(join(project, 'port-anything-report.json'), 'utf8'))).success).toBe(true);
  });

  it('shows stdin in a repro, and a case the corpus lost by its ID', async () => {
    writeFileSync(join(project, 'bin', 'tool-count'), TOOL('ref').replace('cat) cat', 'cat) tr x z'), { mode: 0o755 });
    expect((await run(['run', '--no-sandbox'], { cwd: project })).exitCode).toBe(1);
    expect((await run(['report'], { cwd: project })).exitCode).toBe(0);
    let html = readFileSync(join(project, 'port-anything-report.html'), 'utf8');
    expect(html).toContain('<pre>$ tool cat</pre>\n<p class="note">stdin (6 bytes):</p>\n<pre>x &lt;y&gt;\n</pre>');

    const file = join(project, 'port-anything', 'recorded', 'recorded.jsonl');
    const kept = readFileSync(file, 'utf8');
    writeFileSync(file, kept.split('\n').filter((line) => !line.includes('"cat"')).join('\n'));
    try {
      expect((await run(['report'], { cwd: project })).exitCode).toBe(0);
      html = readFileSync(join(project, 'port-anything-report.html'), 'utf8');
      expect(html).toMatch(/repro: case <code>c_[0-9a-f]{8}<\/code> \(no longer in the corpus\)/);
    } finally {
      writeFileSync(file, kept);
    }
  });

  it('lists the cases a run scored on a re-run after a candidate timeout, and reads runs saved before they were listed', async () => {
    const file = join(runsDir(project), (await latestRun(project))!.run_id, 'run.json');
    const kept = readFileSync(file, 'utf8');
    const saved = JSON.parse(kept);
    const report = async () => {
      writeFileSync(file, JSON.stringify(saved));
      expect((await run(['report'], { cwd: project })).exitCode).toBe(0);
      const json = ReportJsonSchema.parse(JSON.parse(readFileSync(join(project, 'port-anything-report.json'), 'utf8')));
      return { json, html: readFileSync(join(project, 'port-anything-report.html'), 'utf8') };
    };
    try {
      const recovered = `sha256:${'0'.repeat(64)}`;
      saved.candidates[1].timeout_recovered = [{ case: recovered }];
      saved.candidates[1].score.raw.timeoutRecovered = 1;
      let { json, html } = await report();
      expect(json.candidates.map((c) => c.timeout_recovered)).toEqual([[], [recovered], []]);
      expect(json.candidates[1]!.raw.timeout_recovered).toBe(1);
      expect(html).toContain('<li>candidate 2: 1 case (the re-run was compared): <code>c_00000000</code></li>');
      // Saved before: neither the list nor the count.
      for (const c of saved.candidates) {
        delete c.timeout_recovered;
        delete c.score.raw.timeoutRecovered;
        for (const f of c.score.features) delete f.timeoutRecovered;
      }
      ({ json, html } = await report());
      expect(json.candidates.map((c) => [c.timeout_recovered, c.raw.timeout_recovered])).toEqual([[[], 0], [[], 0], [[], 0]]);
      expect(html).toContain('<p>None: no candidate timed out on a first run and then finished on its re-run.</p>');
    } finally {
      writeFileSync(file, kept);
    }
  });

  it('exits 3 for a saved run that lacks what the report shows', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-report-old-')));
    try {
      const runId = '20261014-180203-a1b2';
      mkdirSync(join(other, '.port-anything', 'runs', runId), { recursive: true });
      const old = { version: 1, run_id: runId, created: '2026-10-14T18:02:03.000Z', subset: null, candidate_commands: ['./bin/tool-copy'], clusters: [] };
      writeFileSync(join(other, '.port-anything', 'runs', runId, 'run.json'), JSON.stringify(old));
      expect(await run(['report'], { cwd: other })).toEqual({
        exitCode: 3,
        stdout: '',
        stderr: `port-anything report: Run ${runId} was saved by an older version of port-anything and lacks what the report shows; run port-anything run again.\n`,
      });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses an unknown option with the usage', async () => {
    expect(await run(['report', '--nope'], { cwd: project })).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringContaining('Usage: port-anything report [--html] [--badge] [--json]') });
    expect((await run(['report', 'extra'], { cwd: project })).exitCode).toBe(3);
  });
});

import { scoreCandidate, waiverCoverage, type ScoredCase, type Waiver } from '@port-anything/core';
import { describe, expect, it } from 'vitest';
import { renderReportHtml, type ReportInput } from '../src/index.js';

// Needs @port-anything/core built (`pnpm build`), like the CLI tests.

const id = (n: number) => `sha256:${n.toString(16).padStart(8, '0')}${'a'.repeat(56)}`;

/** The corpus: 25 `base` cases, 22 `opt.n`, 5 `opt.x` (under-sampled), 3 `opt.help` (self-description). */
const CORPUS = [
  ...Array.from({ length: 25 }, () => ['base']),
  ...Array.from({ length: 22 }, () => ['opt.n']),
  ...Array.from({ length: 5 }, () => ['opt.x']),
  ...Array.from({ length: 3 }, () => ['opt.help']),
].map((features, n) => ({ caseId: id(n + 1), features, origin: n < 40 ? ('recorded' as const) : ('generated' as const) }));

const SPEC_FEATURES = ['base', 'opt.n', 'opt.x', 'opt.help', 'opt.z'].map((name) => ({ name, selfDescription: false }));

const WAIVERS: Waiver[] = [
  { match: { feature: 'opt.x', field: 'stdout', shape: 'missing-trailing-newline' }, category: 'intentional', reason: 'trailing newline <by design>' },
  { match: { feature: 'base', field: 'exit', shape: 'exit-code' }, category: 'reference-bug', reason: 'the original exits 0 after "write error"' },
];

/** One candidate: which cases diverge, and which of those a waiver covers (waiver index, from 0). */
function candidate(command: string, diverging: readonly number[], waived: ReadonlyMap<number, number> = new Map()) {
  const cases: ScoredCase[] = CORPUS.map((c, n) => ({ ...c, verdict: diverging.includes(n + 1) ? 'diverge' : 'match', waived: waived.has(n + 1) }));
  const score = scoreCandidate(cases, { minCasesPerFeature: 20, features: SPEC_FEATURES });
  const matches = CORPUS.map((_, n) => (waived.has(n + 1) ? { fields: [[waived.get(n + 1)!]], waived: true, remaining: [] } : { fields: [[]], waived: false, remaining: [] }));
  return {
    command,
    match: CORPUS.length - diverging.length,
    diverge: diverging.length - waived.size,
    waived: waived.size,
    score,
    waivers: waiverCoverage(WAIVERS, matches, CORPUS.length),
    waivedCases: [...waived].map(([n, w]) => ({ case: id(n), waivers: [w + 1] })),
  };
}

const INPUT: ReportInput = {
  runId: '20261014-180203-a1b2',
  created: '2026-10-14T18:02:03.000Z',
  programName: 'tool',
  sandbox: 'bwrap (no network)',
  reference: './bin/tool',
  compare: { profile: 'default', stderr: { mode: 'loose', similarity: 0.8 } },
  cases: CORPUS.length,
  normalizers: [{ normalizer: 'tmp-paths', cases: 4 }],
  waivers: WAIVERS,
  candidates: [
    candidate('./port-a/tool', []),
    candidate('./port-b/tool', [2, 3, 30, 53, 54]),
    candidate("'./port c/tool' --strict", [1, 4, 26, 27, 28, 48, 49], new Map([[1, 1], [48, 0], [49, 0]])),
  ],
  clusters: [
    { cluster: 1, candidate: 2, signature: { fields: ['stdout'], shapes: [{ field: 'stdout', shape: 'number-value' }] }, features: [{ feature: 'base', cases: 2 }, { feature: 'opt.n', cases: 1 }], size: 3, weight: 0.12, cases: [id(2), id(3), id(30)], repro: id(3) },
    { cluster: 2, candidate: 2, signature: { fields: ['stdout'], shapes: [{ field: 'stdout', shape: 'other' }] }, features: [{ feature: 'opt.help', cases: 2 }], size: 2, weight: 0.6, cases: [id(53), id(54)] },
    { cluster: 3, candidate: 3, signature: { fields: ['exit'], shapes: [{ field: 'exit', shape: 'exit-code', detail: '0 vs 2' }] }, features: [{ feature: 'opt.n', cases: 3 }, { feature: 'base', cases: 1 }], size: 4, weight: 0.17, cases: [id(4), id(26), id(27), id(28)], repro: id(26) },
  ],
  repros: {
    [id(3)]: { argv: ['-n', 'a file.txt'], env: { LC_ALL: 'C' }, stdin: { bytes: 6, text: 'x\n<y>\n' }, fixtures: [{ path: 'a file.txt', bytes: 4, text: 'abc\n' }] },
    [id(1)]: { argv: [], env: {}, stdin: { bytes: 70000, text: 'z'.repeat(40), truncated: true }, fixtures: [{ path: 'bin.dat', bytes: 3 }] },
  },
};

describe('renderReportHtml', () => {
  const html = renderReportHtml(INPUT);

  it('renders a 3-candidate run (snapshot)', async () => {
    await expect(html).toMatchFileSnapshot('__snapshots__/three-candidates.html');
  });

  it('renders the N-way matrix: one column per candidate, one row per feature, grouped', () => {
    const table = /<section id="matrix">[\s\S]*?<\/section>/.exec(html)![0];
    const header = /<thead>[\s\S]*?<\/thead>/.exec(table)![0];
    expect(header.match(/<th scope="col">candidate \d/g)).toEqual(['<th scope="col">candidate 1', '<th scope="col">candidate 2', '<th scope="col">candidate 3']);
    const rows = [...table.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((m) => [m[1]!.replace(/<\/?code>/g, ''), m[2]!.match(/<td/g)!.length]);
    expect(rows).toEqual([
      ['headline (mean)', 3],
      ['base', 3],
      ['opt.n', 3],
      ['opt.x', 3],
      ['opt.help', 3],
    ]);
    // Groups in order: headline features, under-sampled, self-description.
    expect([...table.matchAll(/scope="rowgroup">(.*?)</g)].map((m) => m[1])).toEqual([
      'In the headline',
      'Under-sampled (not in the headline)',
      'Self-description (not in the headline)',
    ]);
    // Candidate 2: base 23/25, opt.n 21/22 → (0.92 + 0.954…) / 2.
    expect(table).toContain('<td class="num high">92.0% <span class="note">(23/25)</span></td>');
    expect(table).toContain('<td class="num high"><strong>93.7%</strong></td>');
    // Candidate 3: the waived base case is not scored (1 of 24 diverges besides it).
    expect(table).toContain('<td class="num high">95.8% <span class="note">(23/24)</span></td>');
  });

  it('opens offline: one file, nothing fetched, no scripts', () => {
    expect(html).not.toMatch(/<script|<link|<iframe|<img|<object|<embed|@import|url\(/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('lists untested, under-sampled and self-description features', () => {
    expect(section('untested')).toContain('<li><code>opt.z</code></li>');
    expect(section('under-sampled')).toContain('<li>candidate 1: <code>opt.x</code> 100.0% (5 scored cases)</li>');
    expect(section('under-sampled')).toContain('<li>candidate 3: <code>opt.x</code> 100.0% (3 scored cases)</li>');
    expect(section('self-description')).toContain('<li>candidate 2: <code>opt.help</code> 33.3% (3 scored cases)</li>');
  });

  it('shows each cluster with its repro, quoted for the shell, under its candidate', () => {
    const clusters = section('clusters');
    expect(clusters).toContain('<h3>candidate 1 <code>./port-a/tool</code>: 0 clusters</h3>');
    expect(clusters).toContain('<h3>cluster 3: 4 cases · exit 0 vs 2</h3>');
    expect(clusters).toContain(`<pre>$ LC_ALL=C tool -n &#39;a file.txt&#39;</pre>`);
    expect(clusters).toContain('<pre>x\n&lt;y&gt;\n</pre>');
    expect(clusters).toContain('file <code>a file.txt</code> (4 bytes)');
    // A repro case the run named but the corpus no longer has.
    expect(clusters).toContain('repro: case <code>c_0000001a</code> (no longer in the corpus)');
  });

  it('writes an environment name the shell cannot assign through env(1)', () => {
    const repro = INPUT.repros[id(3)]!;
    const odd = renderReportHtml({ ...INPUT, repros: { ...INPUT.repros, [id(3)]: { ...repro, env: { LC_ALL: 'C', 'MY-VAR': 'a b' } } } });
    expect(odd).toContain(`<pre>$ env LC_ALL=C &#39;MY-VAR=a b&#39; tool -n &#39;a file.txt&#39;</pre>`);
  });

  it('lists reference bugs with the cases each candidate has, and a repro', () => {
    const bugs = section('reference-bugs');
    expect(bugs).toContain('<h3>waiver 2: the original exits 0 after &quot;write error&quot;</h3>');
    expect(bugs).toContain('candidate 1: 0 cases · candidate 2: 0 cases · candidate 3: 1 case');
    expect(bugs).toContain('stdin (70000 bytes):');
    expect(bugs).toContain(`<pre>${'z'.repeat(40)}\n…</pre>`);
    expect(bugs).toContain('(binary, not shown)');
    expect(renderReportHtml({ ...INPUT, waivers: [WAIVERS[0]!] })).toContain('<h2>Reference bugs found</h2>\n<p class="note">Divergences where the candidate is right');
  });

  it('shows the integrity panel the run has data for, and says what this version does not check', () => {
    const integrity = section('integrity');
    expect(integrity).toContain('<li>sandbox: bwrap (no network)</li>');
    expect(integrity).toContain('<li>compared under: default (stderr loose, similarity 0.8)</li>');
    expect(integrity).toContain('<td><code>tmp-paths</code></td><td class="num">4 (7.2%)</td>');
    // Waiver coverage per candidate, flagged when large.
    expect(integrity).toContain('<td class="num">2 (3.6%)</td>');
    const [a, b, c] = INPUT.candidates;
    const large = renderReportHtml({ ...INPUT, candidates: [a!, b!, { ...c!, waivers: [{ waiver: 1, cases: 6, share: 0.11, large: true }, c!.waivers[1]!] }] });
    expect(large).toContain('<td class="num">6 (11.0%) <span class="flag">more than 10% of the cases</span></td>');
    expect(integrity).toContain('fresh holdout: not run by this version');
  });

  it('escapes everything that comes from the project', () => {
    const evil = renderReportHtml({
      ...INPUT,
      programName: '<script>alert(1)</script>',
      waivers: [{ ...WAIVERS[0]!, reason: '</td><img src=x onerror=alert(1)>' }],
    });
    expect(evil).not.toContain('<script>');
    expect(evil).not.toContain('<img');
    expect(evil).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders the same bytes for the same run', () => {
    expect(renderReportHtml(structuredClone(INPUT))).toBe(html);
  });

  function section(name: string): string {
    return new RegExp(`<section id="${name}">[\\s\\S]*?</section>`).exec(html)![0];
  }
});

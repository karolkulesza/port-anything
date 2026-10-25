import { describe, expect, it } from 'vitest';
import { renderReportHtml, type ReportInput } from '../src/index.js';
import { INPUT, WAIVERS, id } from './three-candidates.js';

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

  it('lists the cases scored on a re-run after a candidate timeout, with their count', () => {
    const cards = section('headline');
    expect(cards).toContain('· 2 timeout, recovered on re-run</p>');
    expect(cards).toContain('· 0 timeout, recovered on re-run</p>');
    const integrity = section('integrity');
    expect(integrity).toContain('<h3>Timeout, recovered on re-run</h3>');
    expect(integrity).toContain(`<li>candidate 2: 2 cases (the re-run was compared): <code>c_00000005</code>, <code>c_0000001e</code></li>`);
    expect(integrity).not.toContain('<li>candidate 1:');
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
    expect(integrity).toContain('<li>fresh holdout: 180 new cases from a seed that is not stored, gap to the corpus tested at <code>holdout.gap_alpha</code> 0.01 · 1 left out as flaky-reference · 61 diverging cases saved with the run</li>');
    const { holdout: _, ...older } = INPUT;
    const without = (holdout: ReportInput['holdout']) =>
      section('integrity', renderReportHtml({ ...older, ...(holdout === undefined ? {} : { holdout }), candidates: INPUT.candidates.map(({ holdout: _h, ...c }) => c) }));
    expect(without({ ran: false, reason: 'turned off with --holdout 0' })).toContain('<li>fresh holdout: not run, turned off with --holdout 0</li>');
    expect(without(undefined)).toContain('<li>fresh holdout: not recorded by the version that saved this run</li>');
  });

  it("shows each candidate's fresh-holdout parity next to its headline, flagging a significant gap", () => {
    const cards = section('headline').split('<div class="card">').slice(1);
    expect(cards[0]).toContain('<p>fresh holdout 100.0% (95% CI 97.9%–100.0%), mean of 2 features · gap to the corpus 0.0 points on mutated cases of 2 features (corpus 100.0%, holdout 100.0%): not significant (p = 1.0)</p>');
    expect(cards[1]).toContain('<p>fresh holdout 94.0% (95% CI 90.2%–97.7%), mean of 2 features · gap to the corpus not tested: the corpus has no generated mutated cases to compare with</p>');
    expect(cards[2]).toContain(
      '<p>fresh holdout 66.0% (95% CI 59.1%–72.8%), mean of 2 features · gap to the corpus 34.8 points on mutated cases of 2 features (corpus 95.8%, holdout 61.0%): <span class="flag">significant: better on the corpus than on new cases</span> (p &lt; 0.0001)</p>',
    );
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

  function section(name: string, page = html): string {
    return new RegExp(`<section id="${name}">[\\s\\S]*?</section>`).exec(page)![0];
  }
});

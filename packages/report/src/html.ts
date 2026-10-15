import {
  LARGE_WAIVER_SHARE,
  describeFeatures,
  describeSignature,
  describeWaiver,
  shortCaseId,
  type FeatureScore,
  type SavedCluster,
  type Score,
  type Waiver,
  type WaiverCoverage,
} from '@port-anything/core';

/** A file's content as the report shows it: text when it is UTF-8, else only its size. */
export interface ReproContent {
  bytes: number;
  /** Absent for binary content. */
  text?: string;
  /** `text` holds only the start of the content. */
  truncated?: boolean;
}

/** A case written out so it can be run by hand: the program's arguments, environment and inputs. */
export interface ReportRepro {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Null when stdin is `/dev/null`. */
  stdin: ReproContent | null;
  fixtures: readonly ({ path: string } & ReproContent)[];
}

export interface ReportCandidate {
  command: string;
  match: number;
  diverge: number;
  waived: number;
  score: Score;
  /** Coverage of each waiver of the run, in file order. */
  waivers: readonly WaiverCoverage[];
  /** Waived cases with the waivers (numbered from 1) that cover them. */
  waivedCases: readonly { case: string; waivers: readonly number[] }[];
  /** Cases scored on the candidate's re-run, its first run having timed out where the reference finished. */
  timeoutRecovered: readonly string[];
}

/** What `report.html` shows: one saved run of the whole corpus, and the cases it shows as repros. */
export interface ReportInput {
  runId: string;
  /** When the run was saved, ISO 8601. */
  created: string;
  programName: string;
  /** The sandbox the run used, as the run reported it. */
  sandbox: string;
  reference: string;
  compare: { profile: string; stderr?: { mode: string; similarity?: number } };
  cases: number;
  /** Per normalizer, the cases where it changed either side of a comparison (any candidate). */
  normalizers: readonly { normalizer: string; cases: number }[];
  waivers: readonly Waiver[];
  candidates: readonly ReportCandidate[];
  /** Ranked, numbered through the run; `repro` names the case shown for it. */
  clusters: readonly (SavedCluster & { repro?: string })[];
  /** The cases shown as repros, by case ID; one missing from here is shown by its ID only. */
  repros: Readonly<Record<string, ReportRepro>>;
}

/**
 * Renders the report as one self-contained HTML page: styles inline, no scripts, nothing fetched,
 * so it opens offline and can be attached or archived as a single file. The output depends only
 * on the input, so the same run renders to the same bytes.
 */
export function renderReportHtml(input: ReportInput): string {
  const title = `Port Anything report: ${input.programName}`;
  const sections = [
    headlineSection(input),
    matrixSection(input),
    untestedSection(input),
    underSampledSection(input),
    selfDescriptionSection(input),
    clustersSection(input),
    referenceBugsSection(input),
    integritySection(input),
    rulesSection(input),
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="port-anything">
<title>${esc(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p class="meta">run ${esc(input.runId)} · ${esc(input.created)} · ${count(input.cases, 'case')} · reference <code>${esc(input.reference)}</code></p>
</header>
<main>
${sections.join('\n')}
</main>
</body>
</html>
`;
}

const STYLE = `:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #ffffff; --soft: #f6f8fa; --good: #1a7f37; --warn: #9a6700; --bad: #cf222e; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --soft: #151b23; --good: #3fb950; --warn: #d29922; --bad: #f85149; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 72rem; padding: 1.5rem; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 1.25rem 0 .5rem; }
code, pre { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: .5rem .75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.meta, .note { color: var(--muted); }
.cards { display: flex; flex-wrap: wrap; gap: 1rem; }
.card { flex: 1 1 18rem; border: 1px solid var(--line); border-radius: 8px; padding: .75rem 1rem; }
.card .parity { font-size: 2.2rem; font-weight: 700; }
table { border-collapse: collapse; margin: .5rem 0; }
th, td { border: 1px solid var(--line); padding: .25rem .6rem; text-align: left; vertical-align: top; }
thead th { background: var(--soft); }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.group th { background: var(--soft); font-weight: 600; }
.full { color: var(--good); }
.high { color: var(--warn); }
.low { color: var(--bad); }
.out { color: var(--muted); font-style: italic; }
.flag { color: var(--bad); font-weight: 600; }
.cluster { border: 1px solid var(--line); border-radius: 8px; padding: .5rem 1rem; margin: .75rem 0; }
.cluster h3 { margin-top: .25rem; }`;

function headlineSection(input: ReportInput): string {
  const cards = input.candidates.map((c, i) => {
    const s = c.score;
    const features = s.headlineFeatures.length;
    const lines = [
      `<p class="meta">candidate ${i + 1}</p>`,
      `<p><code>${esc(c.command)}</code></p>`,
      s.headline === null
        ? `<p class="parity out">n/a</p><p>No feature outside self-description has ${count(s.minCasesPerFeature, 'scored case')}.</p>`
        : `<p class="parity ${grade(s.headline)}">${percent(s.headline)}</p><p>mean of ${count(features, 'feature')} · ${s.raw.match} of ${count(s.raw.scored, 'scored case')} match (raw ${percentOrNa(s.raw.parity)})</p>`,
      `<p>${count(c.match, 'case')} match · ${c.diverge} diverge · ${c.waived} waived (not scored)</p>`,
    ];
    const origins = Object.entries(s.origins).filter(([, o]) => o.cases > 0);
    if (origins.length > 0) lines.push(`<p>by origin: ${origins.map(([name, o]) => `${esc(name)} ${percentOrNa(o.parity)} (${count(o.cases, 'case')})`).join(' · ')}</p>`);
    const { flakyReference, flakyCandidate, timeouts, timeoutRecovered } = s.raw;
    lines.push(
      `<p>${flakyReference} flaky-reference (not scored) · ${flakyCandidate} flaky-candidate (diverge) · ${timeouts} timed out (diverge) · ${timeoutRecovered ?? 0} timeout, recovered on re-run</p>`,
    );
    return `<div class="card">\n${lines.join('\n')}\n</div>`;
  });
  return `<section id="headline">
<h2>Parity</h2>
<div class="cards">
${cards.join('\n')}
</div>
</section>`;
}

/** Every feature some candidate's cases carry: the headline's first, then under-sampled, then self-description. */
function matrixRows(input: ReportInput): { group: string; features: string[] }[] {
  const all = new Map<string, FeatureScore>();
  for (const c of input.candidates) for (const f of c.score.features) if (!all.has(f.feature)) all.set(f.feature, f);
  const names = [...all.keys()].sort();
  const anyCandidate = (name: string, test: (f: FeatureScore) => boolean) => input.candidates.some((c) => c.score.features.some((f) => f.feature === name && test(f)));
  const self = names.filter((n) => anyCandidate(n, (f) => f.selfDescription));
  const headline = names.filter((n) => !self.includes(n) && anyCandidate(n, (f) => f.inHeadline));
  const under = names.filter((n) => !self.includes(n) && !headline.includes(n));
  return [
    { group: 'In the headline', features: headline },
    { group: 'Under-sampled (not in the headline)', features: under },
    { group: 'Self-description (not in the headline)', features: self },
  ].filter((g) => g.features.length > 0);
}

function matrixSection(input: ReportInput): string {
  const head = input.candidates.map((c, i) => `<th scope="col">candidate ${i + 1}<br><code>${esc(c.command)}</code></th>`).join('');
  const span = input.candidates.length + 1;
  const body = matrixRows(input).flatMap(({ group, features }) => [
    `<tr class="group"><th colspan="${span}" scope="rowgroup">${esc(group)}</th></tr>`,
    ...features.map((name) => {
      const cells = input.candidates.map((c) => {
        const f = c.score.features.find((x) => x.feature === name);
        if (f === undefined) return '<td class="num out">no cases</td>';
        const cls = f.inHeadline && f.parity !== null ? grade(f.parity) : 'out';
        return `<td class="num ${cls}">${percentOrNa(f.parity)} <span class="note">(${f.match}/${f.scored})</span></td>`;
      });
      return `<tr><th scope="row"><code>${esc(name)}</code></th>${cells.join('')}</tr>`;
    }),
  ]);
  const headlines = input.candidates.map((c) => `<td class="num ${c.score.headline === null ? 'out' : grade(c.score.headline)}"><strong>${percentOrNa(c.score.headline)}</strong></td>`);
  return `<section id="matrix">
<h2>Features × candidates</h2>
<p class="note">Parity per feature: matching cases over scored cases (waived and flaky-reference cases are not scored).</p>
<table>
<thead><tr><th scope="col">feature</th>${head}</tr></thead>
<tbody>
<tr><th scope="row">headline (mean)</th>${headlines.join('')}</tr>
${body.join('\n')}
</tbody>
</table>
</section>`;
}

function untestedSection(input: ReportInput): string {
  const untested = [...new Set(input.candidates.flatMap((c) => c.score.untested))].sort();
  const body = untested.length === 0 ? '<p>None: every feature the CLI spec defines has cases.</p>' : `<ul>\n${untested.map((f) => `<li><code>${esc(f)}</code></li>`).join('\n')}\n</ul>`;
  return `<section id="untested">
<h2>Untested features</h2>
<p class="note">Features in the CLI spec that no case carries. They don't count toward the headline, so they are listed here instead.</p>
${body}
</section>`;
}

/** A list, per candidate, of the features one of `pick` returns. */
function perCandidateFeatures(input: ReportInput, pick: (s: Score) => readonly string[], none: string): string {
  const items = input.candidates.flatMap((c, i) => {
    const names = pick(c.score);
    if (names.length === 0) return [];
    const list = names.map((name) => c.score.features.find((f) => f.feature === name)!).map((f) => `<code>${esc(f.feature)}</code> ${percentOrNa(f.parity)} (${count(f.scored, 'scored case')})`);
    return [`<li>candidate ${i + 1}: ${list.join(', ')}</li>`];
  });
  return items.length === 0 ? `<p>${none}</p>` : `<ul>\n${items.join('\n')}\n</ul>`;
}

function underSampledSection(input: ReportInput): string {
  const min = input.candidates[0]?.score.minCasesPerFeature;
  return `<section id="under-sampled">
<h2>Under-sampled features</h2>
<p class="note">Features with fewer than ${min === undefined ? 'the minimum of' : count(min, 'scored case')} (<code>corpus.min_cases_per_feature</code>): shown, but left out of the headline so a single case can't swing it.</p>
${perCandidateFeatures(input, (s) => s.underSampled, 'None.')}
</section>`;
}

function selfDescriptionSection(input: ReportInput): string {
  return `<section id="self-description">
<h2>Self-description features</h2>
<p class="note"><code>--help</code>, <code>--version</code>, <code>--usage</code> and features marked <code>self_description: true</code> in the CLI spec. Their text differs between implementations by design, so they are reported here and left out of the headline.</p>
${perCandidateFeatures(input, (s) => s.selfDescription, 'None.')}
</section>`;
}

/** Cluster case IDs listed before the rest go under "… more". */
const LISTED_CASES = 20;

function clustersSection(input: ReportInput): string {
  const groups = input.candidates.map((c, i) => {
    const clusters = input.clusters.filter((k) => k.candidate === i + 1);
    const heading = `<h3>candidate ${i + 1} <code>${esc(c.command)}</code>: ${count(clusters.length, 'cluster')}</h3>`;
    return [heading, ...clusters.map((k) => clusterBlock(input, k))].join('\n');
  });
  return `<section id="clusters">
<h2>Clusters</h2>
<p class="note">Diverging cases grouped by what differs, heaviest first: a cluster's weight is how much of the per-feature headline it holds down. The repro is the cluster's smallest case.</p>
${groups.join('\n')}
</section>`;
}

function clusterBlock(input: ReportInput, k: SavedCluster & { repro?: string }): string {
  const listed = k.cases.slice(0, LISTED_CASES).map((id) => `<code>${esc(shortCaseId(id))}</code>`).join(' ');
  const more = k.size > LISTED_CASES ? ` … and ${k.size - LISTED_CASES} more` : '';
  return [
    `<div class="cluster" id="cluster-${k.cluster}">`,
    `<h3>cluster ${k.cluster}: ${count(k.size, 'case')} · ${esc(describeSignature(k.signature))}</h3>`,
    `<p>features ${esc(describeFeatures(k.features))}</p>`,
    ...(k.repro === undefined ? [] : [reproBlock(input, k.repro)]),
    `<p class="note">cases: ${listed}${more}</p>`,
    '</div>',
  ].join('\n');
}

function referenceBugsSection(input: ReportInput): string {
  const bugs = input.waivers.flatMap((w, n) => (w.category === 'reference-bug' ? [{ w, n: n + 1 }] : []));
  const blocks = bugs.map(({ w, n }) => {
    const perCandidate = input.candidates.map((c, i) => {
      const cases = c.waivedCases.filter((x) => x.waivers.includes(n));
      return { i, cases };
    });
    const counts = perCandidate.map(({ i, cases }) => `candidate ${i + 1}: ${count(cases.length, 'case')}`).join(' · ');
    const first = perCandidate.find((p) => p.cases.length > 0)?.cases[0]?.case;
    return [
      '<div class="cluster">',
      `<h3>waiver ${n}: ${esc(w.reason)}</h3>`,
      `<p><code>${esc(describeWaiver(w))}</code></p>`,
      `<p>${counts}</p>`,
      ...(first === undefined ? [] : [reproBlock(input, first)]),
      '</div>',
    ].join('\n');
  });
  const body = blocks.length === 0 ? '<p>None in this run.</p>' : blocks.join('\n');
  return `<section id="reference-bugs">
<h2>Reference bugs found</h2>
<p class="note">Divergences where the candidate is right and the reference is wrong, waived with category <code>reference-bug</code> in <code>port-anything/waivers.yaml</code>.</p>
${body}
</section>`;
}

function integritySection(input: ReportInput): string {
  const normalizers =
    input.normalizers.length === 0
      ? '<p>Normalizers: none.</p>'
      : `<table>
<thead><tr><th scope="col">normalizer</th><th scope="col">cases changed</th></tr></thead>
<tbody>
${input.normalizers.map((n) => `<tr><td><code>${esc(n.normalizer)}</code></td><td class="num">${n.cases} (${percent(share(n.cases, input.cases))})</td></tr>`).join('\n')}
</tbody>
</table>`;
  const head = input.candidates.map((_, i) => `<th scope="col">cases covered, candidate ${i + 1}</th>`).join('');
  const waivers =
    input.waivers.length === 0
      ? '<p>Waivers: none.</p>'
      : `<table>
<thead><tr><th scope="col">waiver</th><th scope="col">reason</th>${head}</tr></thead>
<tbody>
${input.waivers
  .map((w, n) => {
    const cells = input.candidates.map((c) => {
      const cov = c.waivers[n];
      if (cov === undefined) return '<td class="num out">n/a</td>';
      const flag = cov.large ? ` <span class="flag">more than ${LARGE_WAIVER_SHARE * 100}% of the cases</span>` : '';
      return `<td class="num">${cov.cases} (${percent(cov.share)})${flag}</td>`;
    });
    return `<tr><td>${n + 1}. <code>${esc(describeWaiver(w))}</code></td><td>${esc(w.reason)}</td>${cells.join('')}</tr>`;
  })
  .join('\n')}
</tbody>
</table>`;
  const recovered = input.candidates.flatMap((c, i) =>
    c.timeoutRecovered.length === 0
      ? []
      : [`<li>candidate ${i + 1}: ${count(c.timeoutRecovered.length, 'case')} (the re-run was compared): ${c.timeoutRecovered.map((id) => `<code>${esc(shortCaseId(id))}</code>`).join(', ')}</li>`],
  );
  const c = input.compare;
  const compare = c.stderr === undefined ? `${c.profile} (stderr ignored)` : `${c.profile} (stderr ${c.stderr.mode}${c.stderr.similarity === undefined ? '' : `, similarity ${c.stderr.similarity}`})`;
  return `<section id="integrity">
<h2>Integrity</h2>
<ul>
<li>sandbox: ${esc(input.sandbox)}</li>
<li>program name (argv[0], both sides): <code>${esc(input.programName)}</code></li>
<li>compared under: ${esc(compare)}</li>
<li>manifest verification: not run by this version</li>
<li>environment fingerprint: not recorded by this version</li>
<li>fresh holdout: not run by this version</li>
<li>candidate language composition: not measured by this version</li>
</ul>
<h3>Normalizers</h3>
${normalizers}
<h3>Waivers</h3>
${waivers}
<h3>Timeout, recovered on re-run</h3>
${recovered.length === 0 ? '<p>None: no candidate timed out on a first run and then finished on its re-run.</p>' : `<p class="note">A candidate's first run timed out where the reference finished, and its re-run finished; the re-run is what was compared and scored.</p>\n<ul>\n${recovered.join('\n')}\n</ul>`}
</section>`;
}

function rulesSection(input: ReportInput): string {
  const min = input.candidates[0]?.score.minCasesPerFeature;
  return `<section id="rules">
<h2>How the score is counted</h2>
<ul>
<li>The headline is the mean of per-feature parity, so each feature weighs the same however many cases it has.</li>
<li>A case tagged with several features counts once in each of them; a case without flags counts in <code>base</code>.</li>
<li>Self-description features are reported on their own and left out of the headline.</li>
<li>Features with fewer than ${min === undefined ? 'the minimum of scored cases' : count(min, 'scored case')} are under-sampled: shown, but left out of the headline.</li>
<li>Waived cases are left out of both sides of the parity, never counted as passes.</li>
<li>A flaky candidate or a candidate timeout counts as a divergence; a case where the reference itself is flaky is left out.</li>
<li>A timeout isn't an answer: when a candidate's first run timed out but its re-run finished, the re-run is compared, and the case is listed as recovered. A candidate that times out on both runs diverges.</li>
</ul>
</section>`;
}

function reproBlock(input: ReportInput, caseId: string): string {
  const repro = input.repros[caseId];
  const id = `<code>${esc(shortCaseId(caseId))}</code>`;
  if (repro === undefined) return `<p>repro: case ${id} (no longer in the corpus)</p>`;
  // A name the shell can't assign (`A-B=1 tool`) goes through env(1) instead.
  const entries = Object.entries(repro.env);
  const viaEnv = entries.some(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  const env = entries.map(([k, v]) => (viaEnv ? shellWord(`${k}=${v}`) : `${k}=${shellWord(v)}`));
  const command = [...(viaEnv ? ['env'] : []), ...env, ...[input.programName, ...repro.argv].map(shellWord)].join(' ');
  const parts = [`<p>repro: case ${id}</p>`, `<pre>$ ${esc(command)}</pre>`];
  if (repro.stdin !== null) parts.push(`<p class="note">stdin (${count(repro.stdin.bytes, 'byte')}):</p>`, contentBlock(repro.stdin));
  for (const f of repro.fixtures) parts.push(`<p class="note">file <code>${esc(f.path)}</code> (${count(f.bytes, 'byte')}):</p>`, contentBlock(f));
  return parts.join('\n');
}

function contentBlock(c: ReproContent): string {
  if (c.text === undefined) return '<p class="note">(binary, not shown)</p>';
  return `<pre>${esc(c.text)}${c.truncated === true ? '\n…' : ''}</pre>`;
}

/** A word quoted for a POSIX shell when it needs it. */
function shellWord(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`;
}

function esc(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Rounded down, so that only a full match shows as 100.0%. */
export function percent(p: number): string {
  return `${(Math.floor(p * 1000 + 1e-9) / 10).toFixed(1)}%`;
}

const percentOrNa = (p: number | null) => (p === null ? 'n/a' : percent(p));
const share = (n: number, total: number) => (total === 0 ? 0 : n / total);
const grade = (p: number) => (p >= 1 ? 'full' : p >= 0.9 ? 'high' : 'low');
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

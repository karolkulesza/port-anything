import { LARGE_WAIVER_SHARE, type InlineContent } from '@port-anything/core';
import type { ClusterSummary, FieldDiff, NextReport, RunDelta, StatusReport } from './types.js';

// The tools answer an agent, so their text is short and bounded: long commands, signatures and
// feature lists are cut, and lists stop after a few items. `status` stays within a few hundred tokens.

/** Clusters `status` lists at most. */
export const STATUS_CLUSTERS = 5;
/** Characters `status` lists clusters within (it always lists one), so that it stays under 500 tokens. */
export const STATUS_CHARACTERS = 1100;
/** Candidates `status` and `run` list one by one. */
const LISTED_CANDIDATES = 3;
/** Features listed per cluster. */
const LISTED_FEATURES = 2;
/** Normalizers `status` lists. */
const LISTED_NORMALIZERS = 2;
/** Clusters `run` lists. */
const RUN_CLUSTERS = 3;

/** `text` cut to `max` characters, with `…` standing for the rest. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** Rounded down, so that only a full match shows as 100.0%. */
const percent = (p: number) => `${(Math.floor(p * 1000 + 1e-9) / 10).toFixed(1)}%`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const more = (n: number, shown: number) => (n > shown ? `, +${n - shown} more` : '');

function features(list: ClusterSummary['features']): string {
  const shown = list.slice(0, LISTED_FEATURES).map((f) => `${cut(f.feature, 24)} (${f.cases})`);
  return `${shown.join(', ')}${more(list.length, LISTED_FEATURES)}`;
}

/** One line per cluster, such as `#3 c1 · 12 cases · stdout trailing-newline · sort.numeric (8)`. */
function clusterLine(k: ClusterSummary, run?: string): string {
  const name = run === undefined || k.run === run ? `#${k.cluster}` : `${k.run}/${k.cluster}`;
  return `${name} c${k.candidate} · ${count(k.size, 'case')} · ${cut(k.description, 60)} · ${features(k.features)}`;
}

/** The `status` tool's answer: headline numbers, the top clusters and the integrity state. */
export function formatStatus(s: StatusReport): string {
  if (s.run === null) return 'No saved run of the whole corpus yet. Run `port-anything run` in the project first.';
  const { run } = s;
  const head = [`run ${run.id} (${run.created.slice(0, 16).replace('T', ' ')} UTC): ${count(run.cases, 'case')} as "${cut(run.programName, 20)}", sandbox ${run.sandbox}, compare ${run.compare}`];
  for (const c of s.candidates.slice(0, LISTED_CANDIDATES)) {
    const parity = c.parity === null ? 'parity n/a' : `parity ${percent(c.parity)} over ${count(c.features, 'feature')}`;
    head.push(`c${c.candidate} ${cut(c.command, 32)}: ${parity}; ${c.match} match, ${c.diverge} diverge${c.waived > 0 ? `, ${c.waived} waived` : ''}`);
  }
  if (s.candidates.length > LISTED_CANDIDATES) head.push(`+${s.candidates.length - LISTED_CANDIDATES} more candidates`);

  const i = s.integrity;
  const manifest =
    i.manifest === null
      ? 'not frozen (port-anything baseline)'
      : `frozen, ${count(i.manifest.cases, 'case')}, ${
          i.manifest.environment === 'same' ? 'same environment' : i.manifest.environment === 'unknown' ? 'environment unknown' : `environment differs (${i.manifest.environment.differs.join(', ')})`
        }; port-anything verify checks it`;
  const waivers = i.waivers === 0 ? 'none' : `${i.waivers}${i.largeWaivers > 0 ? ` (${i.largeWaivers} over ${LARGE_WAIVER_SHARE * 100}% of cases)` : ''}`;
  const normalizers =
    i.normalizers.length === 0
      ? 'none'
      : `${i.normalizers
          .slice(0, LISTED_NORMALIZERS)
          .map((n) => `${cut(n.normalizer, 20)} ${n.cases}`)
          .join(', ')}${more(i.normalizers.length, LISTED_NORMALIZERS)}`;
  const tail = [`integrity: manifest ${manifest}`, `  flaky-reference ${i.flakyReference} · waivers ${waivers} · normalizers (cases changed): ${normalizers}`];

  const { total, open, top } = s.clusters;
  if (total === 0) return `${[...head, 'clusters: none', ...tail].join('\n')}\n`;
  tail.push(...(open > 0 ? ['Call next for the top cluster with its repro and diff.'] : []));
  // Cluster lines while the answer stays within its budget, at least one.
  let used = [...head, ...tail].reduce((n, l) => n + l.length + 1, 40);
  const shown: string[] = [];
  for (const k of top.slice(0, STATUS_CLUSTERS)) {
    const line = `  ${clusterLine(k, run.id)}`;
    if (shown.length > 0 && used + line.length + 1 > STATUS_CHARACTERS) break;
    shown.push(line);
    used += line.length + 1;
  }
  const header = `clusters: ${total}, ${open} open${shown.length > 0 ? `; top ${shown.length}:` : ''}`;
  return `${[...head, header, ...shown, ...tail].join('\n')}\n`;
}

/** Characters shown per stdin or file of a repro. */
const REPRO_CHARACTERS = 300;
/** Lines shown per side of a diff, and characters per line. */
const DIFF_LINES = 12;
const LINE_CHARACTERS = 160;
/** Unchanged lines shown before a difference. */
const CONTEXT_LINES = 2;

/** A word as a POSIX shell would need it written. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Inline content as a JSON string (so control characters show), cut. */
function content(c: InlineContent): string {
  if (typeof c !== 'string') return `base64 ${cut(c.base64, REPRO_CHARACTERS)}`;
  const text = JSON.stringify(c);
  return text.length <= REPRO_CHARACTERS ? text : `${cut(text, REPRO_CHARACTERS)} (${c.length} chars)`;
}

/**
 * A compact line diff of two texts: the unchanged lines at the start and end are left out (but a
 * couple before the change, for context), then the reference's lines (`-`) and the candidate's
 * (`+`) in between. Lines are shown as JSON strings when they hold a character that wouldn't
 * show, such as a trailing space or a tab.
 */
export function lineDiff(reference: string, candidate: string): string[] {
  if (reference === candidate) return [];
  const a = reference.split('\n');
  const b = candidate.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const show = (line: string) => cut(/^[ -~]*$/.test(line) && !/\s$/.test(line) ? line : JSON.stringify(line), LINE_CHARACTERS);
  const side = (lines: string[], mark: string) => {
    const shown = lines.slice(0, DIFF_LINES).map((l) => `${mark} ${show(l)}`);
    if (lines.length > DIFF_LINES) shown.push(`${mark} … ${lines.length - DIFF_LINES} more lines`);
    return shown;
  };
  const context = a.slice(Math.max(0, start - CONTEXT_LINES), start).map((l) => `  ${show(l)}`);
  return [`@@ line ${start + 1}`, ...context, ...side(a.slice(start, a.length - end), '-'), ...side(b.slice(start, b.length - end), '+')];
}

function diffLines(d: FieldDiff): string[] {
  if (d.field === 'stdout' || d.field === 'stderr' || d.field === 'fs') return [`${d.field}:`, ...lineDiff(d.reference, d.candidate).map((l) => `  ${l}`)];
  return [`${d.field}: reference ${d.reference}, candidate ${d.candidate}`];
}

/** The `next` tool's answer: the highest-priority open cluster, its repro and the diff. */
export function formatNext(n: NextReport): string {
  if (n.kind === 'no-run') return 'No saved run of the whole corpus yet. Run `port-anything run` in the project first.';
  if (n.kind === 'none-open') {
    return n.total === 0
      ? `Run ${n.run} has no clusters: every case matches, or is waived.\n`
      : `All ${count(n.total, 'cluster')} of run ${n.run} were found fixed when re-run. Run the whole corpus (\`port-anything run\`) to confirm.\n`;
  }
  const { cluster: k, repro } = n;
  const lines = [`cluster ${k.run}/${k.cluster} (highest priority of ${n.open} open): ${clusterLine(k).replace(/^#\d+ /, '')}`];
  const how = repro.minimized ? `minimized from ${repro.source}${repro.exhausted ? ', run budget used up, a smaller one may exist' : ''}` : `case ${repro.source}, not minimized`;
  lines.push(`repro (${how}):`);
  lines.push(`  $ ${[n.programName, ...repro.argv].map(shellWord).join(' ')}`);
  for (const [name, value] of Object.entries(repro.env)) lines.push(`  env ${name}=${JSON.stringify(value)}`);
  for (const [path, c] of Object.entries(repro.fixtures)) lines.push(`  file ${path}: ${content(c)}`);
  if (repro.stdin !== null) lines.push(`  stdin: ${content(repro.stdin)}`);
  if (n.diff.length === 0) {
    lines.push(`The repro no longer diverges: fixed already? Call run with cluster "${k.run}/${k.cluster}".`);
  } else {
    lines.push('diff (reference -, candidate +, after normalizers):');
    for (const d of n.diff) lines.push(...diffLines(d));
    lines.push(`After a fix, call run with cluster "${k.run}/${k.cluster}", then smoke for regressions.`);
  }
  return `${lines.join('\n')}\n`;
}

/** The `run` tool's answer: per candidate what matches now and what changed since the baseline run. */
export function formatRun(r: RunDelta): string {
  const lines = [`run ${r.run}: ${r.selection}, ${count(r.cases, 'case')}${r.flakyReference > 0 ? ` (${r.flakyReference} flaky-reference left out)` : ''}`];
  for (const c of r.candidates.slice(0, LISTED_CANDIDATES)) {
    const delta = c.fixed === null || c.broke === null ? 'no baseline run to compare with' : `fixed ${c.fixed}, broke ${c.broke}${c.brokeCases.length > 0 ? ` (${c.brokeCases.join(' ')}${more(c.broke, c.brokeCases.length)})` : ''}`;
    lines.push(`c${c.candidate} ${cut(c.command, 60)}: ${c.match} match, ${c.diverge} diverge${c.waived > 0 ? `, ${c.waived} waived` : ''}; ${delta}`);
  }
  if (r.candidates.length > LISTED_CANDIDATES) lines.push(`+${r.candidates.length - LISTED_CANDIDATES} more candidates`);
  if (r.baseline !== null) lines.push(`deltas against run ${r.baseline}, the latest run of the whole corpus`);
  if (r.clusters.total === 0) lines.push('clusters: none');
  else {
    lines.push(`clusters: ${r.clusters.total}`);
    for (const k of r.clusters.top.slice(0, RUN_CLUSTERS)) lines.push(`  ${clusterLine(k)}`);
    if (r.clusters.total > RUN_CLUSTERS) lines.push(`  +${r.clusters.total - RUN_CLUSTERS} more`);
    lines.push(`cluster numbers belong to run ${r.run}: address them as "${r.run}/<n>"`);
  }
  return `${lines.join('\n')}\n`;
}

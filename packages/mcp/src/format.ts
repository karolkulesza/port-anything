import { LARGE_WAIVER_SHARE, UNTAGGED_FEATURE, fieldDiffLines, showLine, type InlineContent } from '@port-anything/core';
import type { CaseReport, ClusterSummary, FeatureRow, FeaturesReport, NextReport, ObservedText, ProbeReport, ReproCase, RunDelta, StatusReport } from './types.js';

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
  // The cases left out as flaky-reference next to the ones compared, so the two add up to the frozen corpus.
  const leftOut = s.integrity.flakyReference > 0 ? ` + ${s.integrity.flakyReference} flaky-reference left out,` : '';
  const head = [`run ${run.id} (${run.created.slice(0, 16).replace('T', ' ')} UTC): ${count(run.cases, 'case')}${leftOut} as "${cut(run.programName, 20)}", sandbox ${run.sandbox}, compare ${run.compare}`];
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

/** A case as a shell line, with its variables, files and stdin, indented. */
function invocationLines(programName: string, c: ReproCase): string[] {
  const lines = [`  $ ${[programName, ...c.argv].map(shellWord).join(' ')}`];
  for (const [name, value] of Object.entries(c.env)) lines.push(`  env ${name}=${JSON.stringify(value)}`);
  for (const [path, f] of Object.entries(c.fixtures)) lines.push(`  file ${path}: ${content(f)}`);
  if (c.stdin !== null) lines.push(`  stdin: ${content(c.stdin)}`);
  return lines;
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
  lines.push(`repro (${how}):`, ...invocationLines(n.programName, repro));
  if (n.diff.length === 0) {
    lines.push(`The repro no longer diverges: fixed already? Call run with cluster "${k.run}/${k.cluster}".`);
  } else {
    lines.push('diff (reference -, candidate +, after normalizers):');
    for (const d of n.diff) lines.push(...fieldDiffLines(d));
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

/** Lines shown of a program's stdout or stderr, and of its changed files. */
const OUTPUT_LINES = 20;

/** An output as `stdout: 3 lines` and the lines under it, capped. */
function outputLines(label: string, text: string): string[] {
  if (text === '') return [`  ${label}: (empty)`];
  const lines = text.split('\n');
  const newline = lines[lines.length - 1] === '';
  if (newline) lines.pop();
  const shown = lines.slice(0, OUTPUT_LINES).map((l) => `    | ${showLine(l)}`);
  if (lines.length > OUTPUT_LINES) shown.push(`    | … ${lines.length - OUTPUT_LINES} more lines`);
  return [`  ${label}: ${count(lines.length, 'line')}${newline ? '' : ', no newline at the end'}`, ...shown];
}

/** What a program did: how it ended, its output and the files it changed. */
function observedLines(o: ObservedText): string[] {
  const ended = o.timeout ? 'timed out' : o.signal !== null ? `killed by ${o.signal}` : `exit ${o.exit}`;
  const files = o.fs === '' ? ['  files: no changes'] : outputLines('files', o.fs);
  return [`  ${ended}`, ...outputLines('stdout', o.stdout), ...outputLines('stderr', o.stderr), ...files];
}

const listFeatures = (features: readonly string[]) => (features.length === 0 ? 'no features' : `features ${features.slice(0, 6).join(', ')}${more(features.length, 6)}`);

/** The `case` tool's answer: the case, both observations (before normalizers) and the diff (after). */
export function formatCase(r: CaseReport): string {
  const lines = [`case ${r.id.startsWith('sha256:') ? `c_${r.id.slice(7, 15)}` : r.id} · ${r.origin} · ${listFeatures(r.features)}`];
  lines.push(r.cluster === null ? 'not in a cluster of the latest full run' : `in cluster ${r.cluster.run}/${r.cluster.cluster}: ${clusterLine(r.cluster).replace(/^#\d+ /, '')}`);
  lines.push(...invocationLines(r.programName, r.case));
  lines.push('reference:', ...observedLines(r.reference));
  lines.push(`candidate c${r.candidate.candidate} ${cut(r.candidate.command, 60)}:`, ...observedLines(r.observed));
  if (r.diff.length === 0) lines.push('match: the same after normalizers');
  else {
    lines.push('diff (reference -, candidate +, after normalizers):');
    for (const d of r.diff) lines.push(...fieldDiffLines(d));
  }
  return `${lines.join('\n')}\n`;
}

/** Features `features` lists; a prefix narrows the list. */
export const FEATURE_ROWS = 60;

/** The `features` tool's answer: the spec's features with how many cases test each and their parity. */
export function formatFeatures(r: FeaturesReport): string {
  const lines = [
    r.spec === null
      ? 'no CLI spec (port-anything spec infer writes port-anything/cli-spec.yaml); features from the latest full run\'s cases only'
      : `spec port-anything/cli-spec.yaml: program ${cut(r.spec.program, 30)}, ${count(r.spec.features, 'feature')}`,
  ];
  if (r.run === null) lines.push('no saved run of the whole corpus yet: run port-anything run for per-feature parity');
  else {
    const headline = r.candidates
      .slice(0, LISTED_CANDIDATES)
      .map((c) => `c${c.candidate} ${cut(c.command, 32)} ${c.parity === null ? 'n/a' : percent(c.parity)}`)
      .join(', ');
    lines.push(`parity from run ${r.run.id} (${r.run.created.slice(0, 16).replace('T', ' ')} UTC), headline: ${headline}${more(r.candidates.length, LISTED_CANDIDATES)}`);
  }
  const rows = r.features;
  // Counted by where they come from, so that the spec's count above adds up with the rest.
  const builtIn = (f: FeatureRow) => f.feature === UNTAGGED_FEATURE && f.spec === null;
  const origins =
    r.spec === null
      ? ''
      : ` (${[
          `${rows.filter((f) => f.spec !== null).length} in the spec`,
          ...(rows.some(builtIn) ? [UNTAGGED_FEATURE] : []),
          ...(rows.some((f) => f.spec === null && !builtIn(f)) ? [`${rows.filter((f) => f.spec === null && !builtIn(f)).length} not in the spec`] : []),
        ].join(', ')})`;
  lines.push(`features${r.prefix === null ? '' : ` starting "${r.prefix}"`}: ${rows.length}${origins}${r.run === null ? '' : `; under-sampled = fewer than ${r.run.minCasesPerFeature} scored cases, not in the headline`}`);
  const many = r.candidates.length > 1;
  for (const f of rows.slice(0, FEATURE_ROWS)) {
    const parts = [cut(f.feature, 40)];
    if (f.spec !== null) parts.push(cut(f.spec, 40));
    else if (builtIn(f)) parts.push('no flags');
    if (f.cases !== null) parts.push(count(f.cases, 'case'));
    if (f.cases !== null && f.cases > 0) {
      parts.push(
        f.parity
          .slice(0, LISTED_CANDIDATES)
          .map((p, i) => `${many ? `c${i + 1} ` : ''}${p === null ? 'n/a' : percent(p)}`)
          .join(' '),
      );
    }
    const marks = [
      ...(f.cases === 0 ? ['untested'] : []),
      ...(f.selfDescription ? ['self-description'] : []),
      ...(f.underSampled ? ['under-sampled'] : []),
      ...(r.spec !== null && f.spec === null && !builtIn(f) ? ['not in spec'] : []),
    ];
    lines.push(`  ${parts.join(' · ')}${marks.length > 0 ? ` [${marks.join(', ')}]` : ''}`);
  }
  if (rows.length > FEATURE_ROWS) lines.push(`  +${rows.length - FEATURE_ROWS} more: pass prefix to narrow`);
  return `${lines.join('\n')}\n`;
}

/** The `probe` tool's answer: what the reference did, and where the probe was saved. */
export function formatProbe(r: ProbeReport): string {
  const lines = [`probe ${r.id}, reference only, saved to ${r.path} (not part of the corpus):`, ...invocationLines(r.programName, r.case), 'reference:', ...observedLines(r.observed)];
  return `${lines.join('\n')}\n`;
}

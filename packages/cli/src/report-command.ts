import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BlobStore, CONFIG_FILE, ConfigError, cacheDir, latestRun, loadCommittedCases, readConfigFile, type CanonicalCase, type RunRecord } from '@port-anything/core';
import { renderBadgeSvg, renderReportHtml, reportJson, type ReportCandidate, type ReportInput, type ReportRepro, type ReproContent } from '@port-anything/report';
import { loadCorpus } from './corpus.js';
import type { CandidateHoldout, CliResult, HoldoutSummary } from './run-command.js';

/** Where `report` writes, in the project directory (the HTML under the name `compare` uses too). */
export const REPORT_HTML_FILE = 'port-anything-report.html';
export const REPORT_JSON_FILE = 'port-anything-report.json';

/** The badge of candidate `n` (from 1): the first candidate's is `port-anything-badge.svg`, the others' `port-anything-badge-<n>.svg`. */
export function badgeFile(n: number): string {
  return n === 1 ? 'port-anything-badge.svg' : `port-anything-badge-${n}.svg`;
}

export const USAGE = 'Usage: port-anything report [--html] [--badge] [--json]';

/**
 * `port-anything report [--html] [--badge] [--json]`: writes the latest saved run of the whole
 * corpus to the project directory as a self-contained HTML page (`port-anything-report.html`, with
 * a repro for each cluster taken from the committed cases), a parity badge per candidate
 * (`port-anything-badge.svg`, then `port-anything-badge-2.svg`…) and machine-readable JSON
 * (`port-anything-report.json`). Without options it writes all three. Exit 0, or 3 when there is
 * no run to report.
 */
export async function reportCommand(argv: readonly string[], options: { cwd: string }): Promise<CliResult> {
  try {
    let values: { html?: boolean; badge?: boolean; json?: boolean };
    try {
      ({ values } = parseArgs({ args: [...argv], options: { html: { type: 'boolean' }, badge: { type: 'boolean' }, json: { type: 'boolean' } }, strict: true, allowPositionals: false }));
    } catch (e) {
      throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
    }
    const all = values.html !== true && values.badge !== true && values.json !== true;
    const run = await latestRun(options.cwd);
    if (run === undefined) throw new ConfigError('No saved run of the whole corpus yet: run port-anything run first.');
    const store = new BlobStore(cacheDir(options.cwd));
    // Generated cases only from the cache, since the report runs no program; without a config, only the committed ones.
    const config = await readConfigFile(options.cwd).catch((e: unknown) => {
      if (e instanceof ConfigError && e.message.startsWith(`No ${CONFIG_FILE} `)) return undefined;
      throw e;
    });
    const cases = config === undefined ? await loadCommittedCases(options.cwd, store) : await loadCorpus(options.cwd, config, 'cache-only');
    const input = await reportInput(run, cases, store);
    const files: [string, string][] = [];
    if (all || values.html === true) files.push([REPORT_HTML_FILE, renderReportHtml(input)]);
    if (all || values.json === true) files.push([REPORT_JSON_FILE, `${JSON.stringify(reportJson(input), null, 2)}\n`]);
    if (all || values.badge === true) for (const [i, c] of input.candidates.entries()) files.push([badgeFile(i + 1), renderBadgeSvg(c.score)]);
    for (const [name, content] of files) await writeAtomically(options.cwd, name, content);
    return { exitCode: 0, stdout: `report of run ${run.run_id}: ${files.map(([name]) => `./${name}`).join(', ')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof ConfigError) return { exitCode: 3, stdout: '', stderr: `port-anything report: ${e.message}\n` };
    throw e;
  }
}

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
async function writeAtomically(dir: string, name: string, content: string): Promise<void> {
  const file = join(dir, name);
  const temp = `${file}.tmp`;
  try {
    await writeFile(temp, content);
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true });
    throw new ConfigError(`Cannot write ${name}: ${(e as Error).message}`);
  }
}

/** What `run` saves beyond what addressing clusters needs (see `executeRun`). */
interface SavedReport {
  program_name: string;
  sandbox: string;
  reference: string;
  compare: ReportInput['compare'];
  cases: number;
  normalizers: ReportInput['normalizers'];
  waivers: ReportInput['waivers'];
  /** Absent in a run saved before the fresh holdout. */
  holdout?: HoldoutSummary;
  candidates: (Omit<ReportCandidate, 'waivedCases' | 'holdout'> & { waived_cases: ReportCandidate['waivedCases']; holdout?: CandidateHoldout })[];
}

/**
 * The report of a saved run: its numbers as saved, and as repros the committed cases it names
 * (each cluster's smallest case, the first case of each reference-bug waiver). A case the corpus
 * no longer has is shown by its ID.
 */
export async function reportInput(run: RunRecord, cases: readonly CanonicalCase[], store: BlobStore): Promise<ReportInput> {
  const saved = run as RunRecord & Partial<SavedReport>;
  const missing = (['program_name', 'sandbox', 'reference', 'compare', 'cases', 'normalizers', 'waivers', 'candidates'] as const).filter((key) => saved[key] === undefined);
  if (missing.length > 0 || saved.candidates!.some((c) => c.score === undefined || c.waived_cases === undefined)) {
    throw new ConfigError(`Run ${run.run_id} was saved by an older version of port-anything and lacks what the report shows; run port-anything run again.`);
  }
  const s = saved as RunRecord & SavedReport;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const sizes = new Map<string, number>();
  const size = async (c: CanonicalCase) => {
    let n = sizes.get(c.id);
    if (n === undefined) {
      n = c.argv.reduce((sum, a) => sum + Buffer.byteLength(a) + 1, 0) + Object.entries(c.env).reduce((sum, [k, v]) => sum + Buffer.byteLength(k) + Buffer.byteLength(v) + 1, 0);
      for (const ref of [...(c.stdin === null ? [] : [c.stdin]), ...Object.values(c.fixtures)]) n += (await store.get(ref)).length;
      sizes.set(c.id, n);
    }
    return n;
  };
  // The smallest of a cluster's cases the corpus still has, the first of them on a tie; else its first case.
  const clusters = await Promise.all(
    s.clusters.map(async (k) => {
      let best: { id: string; size: number } | undefined;
      for (const id of k.cases) {
        const c = byId.get(id);
        if (c === undefined) continue;
        const n = await size(c);
        if (best === undefined || n < best.size) best = { id, size: n };
      }
      return { ...k, repro: best?.id ?? k.cases[0]! };
    }),
  );
  const shown = new Set(clusters.map((k) => k.repro));
  for (const [n, w] of s.waivers.entries()) {
    if (w.category !== 'reference-bug') continue;
    const first = s.candidates.flatMap((c) => c.waived_cases).find((x) => x.waivers.includes(n + 1));
    if (first !== undefined) shown.add(first.case);
  }
  const repros: Record<string, ReportRepro> = {};
  for (const id of shown) {
    const c = byId.get(id);
    if (c !== undefined) repros[id] = await repro(c, store);
  }
  return {
    runId: s.run_id,
    created: s.created,
    programName: s.program_name,
    sandbox: s.sandbox,
    reference: s.reference,
    compare: s.compare,
    cases: s.cases,
    normalizers: s.normalizers,
    waivers: s.waivers,
    ...(s.holdout === undefined
      ? {}
      : {
          holdout: s.holdout.ran
            ? { ran: true, cases: s.holdout.cases, inCorpus: s.holdout.in_corpus, flakyReference: s.holdout.flaky_reference, alpha: s.holdout.alpha, saved: s.holdout.saved }
            : { ran: false, reason: s.holdout.reason },
        }),
    candidates: s.candidates.map(({ waived_cases, holdout, ...c }) => ({
      command: c.command,
      match: c.match,
      diverge: c.diverge,
      waived: c.waived,
      score: c.score,
      waivers: c.waivers,
      waivedCases: waived_cases,
      ...(holdout === undefined
        ? {}
        : {
            holdout: {
              match: holdout.match,
              diverge: holdout.diverge,
              parity: holdout.parity,
              ci95: holdout.ci95,
              features: holdout.features,
              gap: holdout.gap === null ? null : { corpus: holdout.gap.corpus, holdout: holdout.gap.holdout, gap: holdout.gap.gap, pValue: holdout.gap.p_value, features: holdout.gap.features.length },
              ...(holdout.no_gap === undefined ? {} : { noGap: holdout.no_gap }),
              significant: holdout.significant,
            },
          }),
    })),
    clusters,
    repros,
  };
}

/** Text shown per stdin or file of a repro; longer content is cut. */
const SHOWN_CHARACTERS = 2000;

async function repro(c: CanonicalCase, store: BlobStore): Promise<ReportRepro> {
  const content = async (ref: string): Promise<ReproContent> => {
    const bytes = await store.get(ref);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { bytes: bytes.length };
    }
    const chars = [...text];
    return chars.length > SHOWN_CHARACTERS ? { bytes: bytes.length, text: chars.slice(0, SHOWN_CHARACTERS).join(''), truncated: true } : { bytes: bytes.length, text };
  };
  const fixtures = [];
  for (const [path, ref] of Object.entries(c.fixtures).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) fixtures.push({ path, ...(await content(ref)) });
  return { argv: c.argv, env: c.env, stdin: c.stdin === null ? null : await content(c.stdin), fixtures };
}

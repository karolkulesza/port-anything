import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BlobStore, ConfigError, cacheDir, latestRun, loadCommittedCases, type CanonicalCase, type RunRecord } from '@port-anything/core';
import { renderReportHtml, type ReportCandidate, type ReportInput, type ReportRepro, type ReproContent } from '@port-anything/report';
import type { CliResult } from './run-command.js';

/** Where `report --html` writes, in the project directory (the name `compare` uses too). */
export const REPORT_HTML_FILE = 'port-anything-report.html';

const USAGE = 'Usage: port-anything report [--html]';

// Documented options that later versions add.
const NOT_YET = ['badge', 'json'];

/**
 * `port-anything report [--html]`: writes the latest saved run of the whole corpus as a
 * self-contained HTML page, `port-anything-report.html` in the project directory, with a repro for
 * each cluster taken from the committed cases. Exit 0, or 3 when there is no run to report.
 */
export async function reportCommand(argv: readonly string[], options: { cwd: string }): Promise<CliResult> {
  try {
    const later = NOT_YET.find((name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)));
    if (later !== undefined) throw new ConfigError(`--${later} is not available yet in this version of port-anything report.`);
    try {
      parseArgs({ args: [...argv], options: { html: { type: 'boolean' } }, strict: true, allowPositionals: false });
    } catch (e) {
      throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
    }
    const run = await latestRun(options.cwd);
    if (run === undefined) throw new ConfigError('No saved run of the whole corpus yet: run port-anything run first.');
    const store = new BlobStore(cacheDir(options.cwd));
    const cases = await loadCommittedCases(options.cwd, store);
    const html = renderReportHtml(await reportInput(run, cases, store));
    const file = join(options.cwd, REPORT_HTML_FILE);
    const temp = `${file}.tmp`;
    try {
      await writeFile(temp, html);
      await rename(temp, file);
    } catch (e) {
      await rm(temp, { force: true });
      throw new ConfigError(`Cannot write ${REPORT_HTML_FILE}: ${(e as Error).message}`);
    }
    return { exitCode: 0, stdout: `report of run ${run.run_id}: ./${REPORT_HTML_FILE}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof ConfigError) return { exitCode: 3, stdout: '', stderr: `port-anything report: ${e.message}\n` };
    throw e;
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
  candidates: (Omit<ReportCandidate, 'waivedCases'> & { waived_cases: ReportCandidate['waivedCases'] })[];
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
    candidates: s.candidates.map(({ waived_cases, ...c }) => ({ command: c.command, match: c.match, diverge: c.diverge, waived: c.waived, score: c.score, waivers: c.waivers, waivedCases: waived_cases })),
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

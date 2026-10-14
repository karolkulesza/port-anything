import { execFile } from 'node:child_process';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RUN_ID_PATTERN } from './runs.js';

/**
 * The parity history, `.port-anything/history.jsonl`: one JSON line per run of the whole corpus,
 * oldest first. It is committed, and only ever appended to, so that `merge=union` in
 * `.gitattributes` merges branches that both added runs (see `HISTORY_GITATTRIBUTES`).
 */
export const HISTORY_FILE = 'history.jsonl';

export function historyPath(projectDir: string): string {
  return join(projectDir, '.port-anything', HISTORY_FILE);
}

/** The `.gitattributes` line, relative to the project directory, that merges the history by union. */
export const HISTORY_GITATTRIBUTES = `.port-anything/${HISTORY_FILE} merge=union`;

const HistoryCandidateSchema = z.looseObject({
  /** As given in the config or on the command line. */
  command: z.union([z.string().min(1), z.array(z.string()).min(1)]),
  /** HEAD of the git repository holding the candidate's executable; null outside one. */
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable(),
  /** The headline: mean of per-feature parity; null when no feature qualifies. */
  parity: z.number().min(0).max(1).nullable(),
  /** How many features the headline is the mean of. */
  features: z.number().int().nonnegative(),
  /** Scored cases (waived and flaky-reference ones left out) and how many of them match. */
  scored: z.number().int().nonnegative(),
  match: z.number().int().nonnegative(),
});

/** One line of the history. Unknown keys are kept, so a later version can add some. */
export const HistoryEntrySchema = z.looseObject({
  version: z.literal(1),
  run_id: z.string().regex(RUN_ID_PATTERN),
  /** When the run was saved, ISO 8601 with milliseconds. */
  created: z.iso.datetime(),
  cases: z.number().int().nonnegative(),
  candidates: z.array(HistoryCandidateSchema).min(1),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/**
 * Appends a run to the history in one write, creating the file if needed. A file that doesn't end
 * with a newline (edited by hand) gets one first, so the new line stays a line of its own.
 */
export async function appendHistory(projectDir: string, entry: HistoryEntry): Promise<void> {
  const line = `${JSON.stringify(HistoryEntrySchema.parse(entry))}\n`;
  const file = historyPath(projectDir);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, (await endsWithoutNewline(file)) ? `\n${line}` : line);
}

async function endsWithoutNewline(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

export interface History {
  /** In file order, which is the order the runs were appended (a merge may interleave branches). */
  entries: HistoryEntry[];
  /** 1-based numbers of the lines that aren't a valid entry (left out of `entries`). */
  damaged: number[];
}

/** Reads the history; empty when there is none yet. Blank lines are skipped. */
export async function readHistory(projectDir: string): Promise<History> {
  let text: string;
  try {
    text = await readFile(historyPath(projectDir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], damaged: [] };
    throw e;
  }
  const history: History = { entries: [], damaged: [] };
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let parsed: ReturnType<typeof HistoryEntrySchema.safeParse> | undefined;
    try {
      parsed = HistoryEntrySchema.safeParse(JSON.parse(line));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) history.entries.push(parsed.data);
    else history.damaged.push(i + 1);
  }
  return history;
}

const run = promisify(execFile);

const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];

/**
 * The commit checked out in the git repository that holds the directory `dir`, or null when it
 * isn't in one, the repository has no commit yet, or git isn't installed. Variables that point git
 * at another repository (set when running inside a git hook, say) are ignored.
 */
export async function gitHead(dir: string): Promise<string | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARS.includes(name)));
  try {
    const { stdout } = await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir, env, timeout: 10_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

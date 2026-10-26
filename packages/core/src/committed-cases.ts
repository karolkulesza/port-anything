import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BlobStore } from './blob-store.js';
import { ConfigError } from './config.js';
import { canonicalCase, withoutProtoKeys, type CanonicalCase } from './model.js';

/** Committed cases, one JSON Lines file per source (`recorded.jsonl`, `<importer>.jsonl`). */
export const RECORDED_DIR = 'port-anything/recorded';

/** File content written inline: UTF-8 text, or `{"base64": "…"}` for bytes that aren't. */
export const InlineContentSchema = z.union([z.string(), z.strictObject({ base64: z.base64() })]);

/**
 * One line of a committed case file: the Case shape with inline content instead of blob refs. The
 * other fields are checked by the Case schema once the content is stored.
 */
const LineSchema = withoutProtoKeys(
  z.strictObject({
    id: z.unknown().optional(),
    argv: z.unknown(),
    stdin: InlineContentSchema.nullable().default(null),
    env: z.unknown().optional(),
    fixtures: z.record(z.string(), InlineContentSchema).default({}),
    features: z.unknown().optional(),
    origin: z.unknown(),
  }),
);

export type InlineContent = z.output<typeof InlineContentSchema>;

const bytesOf = (content: InlineContent) => (typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Bytes written inline: as text when they are well-formed UTF-8, else as base64. */
export function inlineContent(bytes: Uint8Array): InlineContent {
  try {
    return utf8.decode(bytes);
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

/**
 * Loads every `port-anything/recorded/*.jsonl` file of the project, in file name order, storing
 * the inline stdin and fixtures in `store`. A case found in several files is returned once. No
 * directory means no committed cases. A broken line is a `ConfigError` naming its file and line.
 */
export async function loadCommittedCases(projectDir: string, store: BlobStore): Promise<CanonicalCase[]> {
  const cases = new Map<string, CanonicalCase>();
  for await (const { where, line } of committedLines(projectDir)) {
    const c = await parseLine(line, store).catch((e: unknown) => {
      throw new ConfigError(`${where}: ${(e as Error).message}`);
    });
    if (!cases.has(c.id)) cases.set(c.id, c);
  }
  return [...cases.values()];
}

/** A feature tag of the committed cases: where it first appears (`<file>:<line>`) and how many lines carry it. */
export interface CommittedFeatureTag {
  feature: string;
  where: string;
  cases: number;
}

/**
 * The feature tags the committed case files use, in the order they first appear, so a tag can be
 * traced to the line that wrote it. Lines that aren't cases are skipped (`loadCommittedCases`
 * reports them).
 */
export async function committedFeatureTags(projectDir: string): Promise<CommittedFeatureTag[]> {
  const tags = new Map<string, CommittedFeatureTag>();
  for await (const { where, line } of committedLines(projectDir)) {
    let features: unknown;
    try {
      features = (JSON.parse(line) as { features?: unknown } | null)?.features;
    } catch {
      continue;
    }
    if (!Array.isArray(features)) continue;
    for (const feature of new Set(features.filter((f): f is string => typeof f === 'string'))) {
      const tag = tags.get(feature);
      if (tag === undefined) tags.set(feature, { feature, where, cases: 1 });
      else tag.cases++;
    }
  }
  return [...tags.values()];
}

/** The non-blank lines of the committed case files, in file name order, each with its `<file>:<line>`. */
async function* committedLines(projectDir: string): AsyncGenerator<{ where: string; line: string }> {
  const dir = join(projectDir, RECORDED_DIR);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ConfigError(`Cannot read ${RECORDED_DIR}: ${(e as Error).message}`);
  }
  for (const name of names.sort()) {
    const lines = (await readFile(join(dir, name), 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() !== '') yield { where: `${RECORDED_DIR}/${name}:${index + 1}`, line };
    }
  }
}

async function parseLine(line: string, store: BlobStore): Promise<CanonicalCase> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (e) {
    throw new Error(`not valid JSON (${(e as Error).message})`);
  }
  const parsed = LineSchema.safeParse(json);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  const { stdin, fixtures, ...rest } = parsed.data;
  const refs: Record<string, string> = {};
  for (const [path, content] of Object.entries(fixtures)) refs[path] = await store.put(bytesOf(content));
  const input = { ...rest, stdin: stdin === null ? null : await store.put(bytesOf(stdin)), fixtures: refs };
  try {
    return canonicalCase(input as Parameters<typeof canonicalCase>[0]);
  } catch (e) {
    throw e instanceof z.ZodError ? new Error(describeIssues(e)) : e;
  }
}

const describeIssues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(line)'}: ${i.message}`).join('; ');

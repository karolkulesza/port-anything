import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BlobStore } from './blob-store.js';
import { ConfigError } from './config.js';
import { canonicalCase, withoutProtoKeys, type CanonicalCase } from './model.js';

/** Committed cases, one JSON Lines file per source (`recorded.jsonl`, `<importer>.jsonl`). */
export const RECORDED_DIR = 'port-anything/recorded';

/** File content written inline: UTF-8 text, or `{"base64": "…"}` for bytes that aren't. */
const ContentSchema = z.union([z.string(), z.strictObject({ base64: z.base64() })]);

/**
 * One line of a committed case file: the Case shape with inline content instead of blob refs. The
 * other fields are checked by the Case schema once the content is stored.
 */
const LineSchema = withoutProtoKeys(
  z.strictObject({
    id: z.unknown().optional(),
    argv: z.unknown(),
    stdin: ContentSchema.nullable().default(null),
    env: z.unknown().optional(),
    fixtures: z.record(z.string(), ContentSchema).default({}),
    features: z.unknown().optional(),
    origin: z.unknown(),
  }),
);

type Content = z.output<typeof ContentSchema>;

const bytesOf = (content: Content) => (typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));

/**
 * Loads every `port-anything/recorded/*.jsonl` file of the project, in file name order, storing
 * the inline stdin and fixtures in `store`. A case found in several files is returned once. No
 * directory means no committed cases. A broken line is a `ConfigError` naming its file and line.
 */
export async function loadCommittedCases(projectDir: string, store: BlobStore): Promise<CanonicalCase[]> {
  const dir = join(projectDir, RECORDED_DIR);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigError(`Cannot read ${RECORDED_DIR}: ${(e as Error).message}`);
  }
  const cases = new Map<string, CanonicalCase>();
  for (const name of names.sort()) {
    const lines = (await readFile(join(dir, name), 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      const where = `${RECORDED_DIR}/${name}:${index + 1}`;
      const c = await parseLine(line, store).catch((e: unknown) => {
        throw new ConfigError(`${where}: ${(e as Error).message}`);
      });
      if (!cases.has(c.id)) cases.set(c.id, c);
    }
  }
  return [...cases.values()];
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

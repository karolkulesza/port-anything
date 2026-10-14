import { z } from 'zod';
import type { BlobStore } from './blob-store.js';
import { type LicenseCheck, checkLicense } from './license.js';
import { type CanonicalCase, canonicalCase } from './model.js';

/** Where an imported case came from: the file and, for formats with several cases per file, the line. */
export interface ImportLocation {
  file: string;
  line?: number;
}

/**
 * What the source says the reference should do. Informational only: the reference's observed
 * behavior is the truth (§4), but a mismatch with the source's own expectation is worth showing.
 */
export type ImportExpectation =
  | { kind: 'output'; lines: string[] }
  | { kind: 'error'; message: string; exactMessage: boolean };

export interface ImportedCase {
  case: CanonicalCase;
  at: ImportLocation;
  expected?: ImportExpectation;
}

export interface ImportSkip {
  at: ImportLocation;
  reason: string;
}

export interface ImportResult {
  kind: ImportKind;
  /** The path given to the importer, as given. */
  source: string;
  /** License check of the source, kept with every import (§10). */
  license: LicenseCheck;
  /** Imported cases, in source order, one per distinct case ID. */
  cases: ImportedCase[];
  /** Entries whose case was already imported from an earlier entry of the same source. */
  duplicates: ImportLocation[];
  /** Entries that could not be turned into a case, with the reason. */
  skipped: ImportSkip[];
}

/** One entry an importer read, before its blobs are stored. */
export interface RawImportCase {
  argv: string[];
  /** Bytes for stdin; `null` means `/dev/null`. */
  stdin: string | Uint8Array | null;
  /** Files in the working directory, by relative path. */
  fixtures?: Record<string, string | Uint8Array>;
  env?: Record<string, string>;
  features?: string[];
  at: ImportLocation;
  expected?: ImportExpectation;
}

/**
 * Turns importer entries into stored, canonical, de-duplicated cases with `origin: imported`.
 * Entries the case model rejects (a NUL byte in argv, a bad fixture path…) are skipped with the
 * reason instead of failing the whole import.
 */
export class ImportCollector {
  readonly cases: ImportedCase[] = [];
  readonly duplicates: ImportLocation[] = [];
  readonly skipped: ImportSkip[] = [];
  readonly #ids = new Set<string>();

  constructor(readonly store: BlobStore) {}

  skip(at: ImportLocation, reason: string): void {
    this.skipped.push({ at, reason });
  }

  async add(raw: RawImportCase): Promise<void> {
    let c: CanonicalCase;
    try {
      const fixtures: Record<string, string> = {};
      for (const [path, data] of Object.entries(raw.fixtures ?? {})) fixtures[path] = await this.store.put(data);
      c = canonicalCase({
        argv: raw.argv,
        stdin: raw.stdin === null ? null : await this.store.put(raw.stdin),
        env: raw.env ?? {},
        fixtures,
        features: raw.features ?? [],
        origin: 'imported',
      });
    } catch (e) {
      if (!(e instanceof z.ZodError)) throw e;
      this.skip(raw.at, `not a valid case: ${e.issues.map((i) => `${i.path.join('.') || 'case'}: ${i.message}`).join('; ')}`);
      return;
    }
    if (this.#ids.has(c.id)) {
      this.duplicates.push(raw.at);
      return;
    }
    this.#ids.add(c.id);
    this.cases.push(raw.expected === undefined ? { case: c, at: raw.at } : { case: c, at: raw.at, expected: raw.expected });
  }
}

/** Options every importer takes. */
export interface ImportOptionsBase {
  /** File or directory to import from. */
  path: string;
  /** SPDX expression of the source's license; skips detection from license files. */
  license?: string;
}

/** An importer reads one kind of source and feeds its entries to the collector. */
export interface Importer<O extends ImportOptionsBase = ImportOptionsBase> {
  readonly kind: ImportKind;
  read(options: O, collector: ImportCollector): Promise<void>;
}

/** Source kinds `port-anything import` understands (§11). More (bats, cram, examples) come later. */
export const IMPORT_KINDS = ['fixtures', 'jq-test'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Runs an importer: checks the source's license, reads it, stores the blobs, returns the cases. */
export async function runImporter<O extends ImportOptionsBase>(
  importer: Importer<O>,
  options: O,
  store: BlobStore,
): Promise<ImportResult> {
  const license = await checkLicense(options.path, options.license);
  const collector = new ImportCollector(store);
  await importer.read(options, collector);
  return {
    kind: importer.kind,
    source: options.path,
    license,
    cases: collector.cases,
    duplicates: collector.duplicates,
    skipped: collector.skipped,
  };
}

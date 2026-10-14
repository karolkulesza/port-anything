import type { BlobStore } from './blob-store.js';
import { IMPORT_KINDS, type ImportResult, runImporter } from './import.js';
import { type FixturesImportOptions, fixturesImporter } from './import-fixtures.js';
import { type JqTestImportOptions, jqTestImporter } from './import-jq-test.js';

/** Options for `importCases`, by source kind. */
export type ImportOptions = ({ kind: 'fixtures' } & FixturesImportOptions) | ({ kind: 'jq-test' } & JqTestImportOptions);

/** Imports cases from a source of the given kind, storing their blobs in `store`. */
export async function importCases(options: ImportOptions, store: BlobStore): Promise<ImportResult> {
  switch (options.kind) {
    case 'fixtures':
      return runImporter(fixturesImporter, options, store);
    case 'jq-test':
      return runImporter(jqTestImporter, options, store);
    default: {
      const kind: unknown = (options as { kind: unknown }).kind;
      throw new Error(`Unknown import source "${String(kind)}": expected one of ${IMPORT_KINDS.join(', ')}.`);
    }
  }
}

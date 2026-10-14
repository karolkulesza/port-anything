/** Name of this package, as published on npm. */
export const PACKAGE_NAME = '@port-anything/core';

export { PACK_CODEC, compressPack, decompressPack } from './pack-codec.js';
export { canonicalJson } from './canonical-json.js';
export {
  BlobRefSchema,
  CaseIdSchema,
  CaseSchema,
  ORIGINS,
  ObservationSchema,
  OriginSchema,
  RelativePathSchema,
  canonicalCase,
  canonicalCaseJson,
  canonicalObservation,
  canonicalObservationJson,
  caseId,
} from './model.js';
export type { CanonicalCase, Case, CaseInput, Observation } from './model.js';
export { CaseIdError, MIN_PREFIX_LENGTH, SHORT_ID_LENGTH, resolveCaseId, shortCaseId } from './case-id.js';
export type { CaseIdErrorCode } from './case-id.js';
export { BlobError, BlobStore, blobRef, cacheDir } from './blob-store.js';
export type { BlobErrorCode } from './blob-store.js';
export {
  SandboxUnavailableError,
  chooseSandbox,
  localHost,
  probeSandbox,
  sandboxCommand,
  type LocalSandbox,
  type SandboxAttempt,
  type SandboxChoice,
  type SandboxCommand,
  type SandboxHost,
  type SandboxKind,
  type SandboxProbe,
  type SandboxSetup,
} from './sandbox.js';
export { checkLicense, findLicenseFiles, identifyLicenses, licenseCategory } from './license.js';
export type { LicenseCategory, LicenseCheck } from './license.js';
export { IMPORT_KINDS, ImportCollector, runImporter } from './import.js';
export type {
  ImportExpectation,
  ImportKind,
  ImportLocation,
  ImportOptionsBase,
  ImportResult,
  ImportSkip,
  ImportedCase,
  Importer,
  RawImportCase,
} from './import.js';
export { DEFAULT_MAX_FIXTURE_BYTES, FIXTURE_PLACEHOLDER, fixturesImporter } from './import-fixtures.js';
export type { FixturesImportOptions } from './import-fixtures.js';
export { importCases } from './importers.js';
export type { ImportOptions } from './importers.js';

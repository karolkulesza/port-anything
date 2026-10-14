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
  BWRAP_STATUS_FD,
  SandboxUnavailableError,
  caseCommandOptions,
  chooseSandbox,
  localHost,
  probeSandbox,
  sandboxCommand,
  type LocalSandbox,
  type SandboxAttempt,
  type SandboxChoice,
  type SandboxCommand,
  type SandboxCommandOptions,
  type SandboxHost,
  type SandboxKind,
  type SandboxProbe,
  type SandboxSetup,
} from './sandbox.js';
export {
  BASE_ENV_ALLOWLIST,
  DEFAULT_CASE_ENV,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  caseEnvironment,
  runProcess,
  type CaseEnvironmentOptions,
  type ProcessResult,
  type ProcessSpec,
} from './process-runner.js';
export {
  MULTICALL_BINARIES,
  defaultProgramName,
  parseProgramCommand,
  pinPrograms,
  pinnedProcess,
  resolveProgram,
  type PinnedProgram,
  type ProgramCommand,
  type ResolveProgramOptions,
  type ResolvedProgram,
} from './program.js';
export {
  DEFAULT_MAX_STORED_FILE_BYTES,
  diffSnapshots,
  fsChanges,
  snapshotDir,
  symlinkBlob,
  type FsChanges,
  type FsChangesOptions,
  type FsSnapshot,
} from './fs-diff.js';

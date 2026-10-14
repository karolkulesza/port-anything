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
export { DEFAULT_GENERATOR, GENERATOR_VERSIONS, createRng, isGeneratorVersion, type GeneratorVersion, type Rng } from './rng.js';
export {
  EDGE,
  TOKEN_KINDS,
  buildTokenDictionary,
  pairKey,
  tokenShape,
  tokenize,
  type DictionarySources,
  type Token,
  type TokenDictionary,
  type TokenKind,
} from './token-dictionary.js';
export { TOKEN_MUTATION_OPS, generateTokenMutants, mutateTokens, type TokenMutant, type TokenMutationOp } from './token-mutation.js';
export { BYTE_MUTATION_OPS, generateByteMutants, mutateBytes, type ByteMutant, type ByteMutationOp } from './byte-mutation.js';

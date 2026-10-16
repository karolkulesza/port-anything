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
  containerSandbox,
  localHost,
  probeSandbox,
  sandboxCommand,
  type LocalSandbox,
  type LocalSetup,
  type SandboxAttempt,
  type SandboxChoice,
  type SandboxCommand,
  type SandboxCommandOptions,
  type SandboxHost,
  type SandboxKind,
  type SandboxProbe,
  type SandboxSetup,
  SEATBELT_PROFILE,
} from './sandbox.js';
export {
  CONTAINER_ENGINES,
  ContainerError,
  ContainerPool,
  ContainerSession,
  DEFAULT_CONTAINER_IMAGE,
  RUNNER_SCRIPT,
  RUNNER_TOOLS,
  containerSpace,
  buildInImage,
  caseScript,
  engineCpus,
  ensureImage,
  findContainerEngine,
  imagePath,
  shellQuote,
  type ContainerPoolOptions,
  type ContainerProcess,
  type ContainerSetup,
} from './container.js';
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
export { jqTestImporter, parseJqTest } from './import-jq-test.js';
export type { JqTest, JqTestImportOptions, JqTestParse } from './import-jq-test.js';
export { importCases } from './importers.js';
export type { ImportOptions } from './importers.js';
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
  isSymlinkBlob,
  snapshotDir,
  symlinkBlob,
  type FsChanges,
  type FsChangesOptions,
  type FsSnapshot,
} from './fs-diff.js';
export { defaultConcurrency, defaultContainerConcurrency, mapPool } from './pool.js';
export {
  COMPARED_FIELDS,
  DEFAULT_STDERR_SIMILARITY,
  PROFILES,
  PROFILE_FIELDS,
  compareExact,
  compareObservations,
  exitClass,
  stderrMode,
  stderrSimilarity,
  type CompareObservationsOptions,
  type CompareOptions,
  type ComparedField,
  type Comparison,
  type ExitClass,
  type Profile,
  type StderrOptions,
} from './compare.js';
export { openCaseRunner, runCases, type CandidateRun, type CaseRun, type CaseRunner, type RunCasesOptions, type RunCasesResult } from './run-cases.js';
export { CONFIG_FILE, ConfigError, ConfigSchema, configCandidates, parseConfig, parseConfigSource, readConfigFile, type Config } from './config.js';
export { InlineContentSchema, RECORDED_DIR, inlineContent, loadCommittedCases, type InlineContent } from './committed-cases.js';
export { DIFF_SHAPES, classifyDiff, classifyText, type DiffShape, type FieldShape, type TextShape } from './diff-shape.js';
export {
  UNTAGGED_FEATURE,
  caseFeatures,
  clusterDivergences,
  clusterSignature,
  describeFeatures,
  describeSignature,
  featureWeights,
  signatureKey,
  type Cluster,
  type ClusterSignature,
  type Divergence,
  type FeatureCount,
} from './cluster.js';
export {
  DEFAULT_MIN_CASES_PER_FEATURE,
  isSelfDescriptionFeature,
  outcome as caseOutcome,
  scoreCandidate,
  type CaseCounts,
  type Outcome,
  type FeatureScore,
  type KnownFeature,
  type OriginScore,
  type Score,
  type ScoreOptions,
  type ScoredCase,
} from './score.js';
export {
  DEFAULT_FRESH_CASES,
  DEFAULT_GAP_ALPHA,
  MIN_GAP_CASES,
  freshHoldoutSeed,
  gapCluster,
  generateFreshHoldout,
  holdoutGap,
  holdoutParity,
  holdoutSettings,
  normalCdf,
  studentTCdf,
  type FreshHoldout,
  type GapCase,
  type GapFeature,
  type GenerateHoldoutOptions,
  type HoldoutGap,
  type HoldoutParity,
  type HoldoutSettings,
} from './holdout.js';
export { measureSlowdown, type Slowdown, type TimedCase } from './slowdown.js';
export {
  DEFAULT_MINIMIZE_RUNS,
  caseSize,
  ddmin,
  minimizeCase,
  minimizeCluster,
  type CaseTest,
  type MinimizeClusterOptions,
  type MinimizeOptions,
  type Minimized,
  type MinimizedCluster,
} from './minimize.js';
export {
  RUN_FILE,
  RUN_ID_PATTERN,
  ReproRecordSchema,
  RunRecordSchema,
  inlineCase,
  latestRun,
  loadRepro,
  loadRun,
  newRunId,
  reproPath,
  parseClusterAddress,
  resolveCluster,
  runsDir,
  saveRepro,
  saveRun,
  type ClusterAddress,
  type InlineCase,
  type ReproRecord,
  type ResolvedCluster,
  type RunRecord,
  type SavedCluster,
} from './runs.js';
export { SMOKE_CASES_PER_FEATURE, SMOKE_PASSING_CASES, openClusterCases, smokeSubset, type SmokeSubset, type SmokeSubsetOptions } from './smoke.js';
export {
  CLI_SPEC_FILE,
  CliSpecSchema,
  POSITIONAL_ARITIES,
  VALUE_TYPES,
  cliSpecYaml,
  parseCliSpec,
  readCliSpecFile,
  specFeatures,
  type CliFlag,
  type CliForm,
  type CliPositional,
  type CliSpec,
  type CliSubcommand,
  type CliValue,
  type SpecFeature,
} from './cli-spec.js';
export { cliSpecFromHelp, isSelfDescription, parseHelp, valueType, type HelpFlag, type ParsedHelp } from './help-parser.js';
export { UNKNOWN_LONG_FLAG, judgeProbes, specProbes, type ProbeOutcome, type SpecProbe, type SpecProbeResult } from './spec-probe.js';
export { inferCliSpec, type InferCliSpecOptions, type InferCliSpecResult } from './spec-infer.js';
export {
  CONTAINER_TOOLS,
  CONTAINER_VERBS,
  DESTRUCTIVE_SUBCOMMANDS,
  DESTRUCTIVE_TOOLS,
  DestructiveToolError,
  assertNotDestructive,
  destructiveCommand,
  destructiveSubcommand,
} from './destructive.js';
export { generateArgvCases, isSafeArgvToken, type ArgvStrategy, type GenerateArgvOptions, type GeneratedArgv, type GeneratedCase } from './argv-generator.js';
export {
  DEDUP_SAMPLE,
  DEFAULT_BUDGET,
  DEFAULT_ERROR_PATH_CAP,
  generateCorpus,
  isErrorObservation,
  type CorpusCase,
  type CorpusStats,
  type CorpusStrategy,
  type GenerateCorpusOptions,
  type GeneratedCorpus,
  type ObserveReference,
} from './corpus-generator.js';
export {
  NORMALIZER_NAMES,
  NormalizerEntrySchema,
  NormalizersSchema,
  PID_PLACEHOLDER,
  PROGRAM_PLACEHOLDER,
  TIMESTAMP_PLACEHOLDER,
  TMP_PLACEHOLDER,
  normalizePair,
  normalizerLabel,
  type NormalizePairOptions,
  type NormalizeSide,
  type NormalizedPair,
  type NormalizerName,
  type NormalizerSpec,
  type ScopeEntry,
  type SideContext,
} from './normalize.js';
export {
  DEFAULT_REPEATS,
  PROPOSABLE_NORMALIZERS,
  baselineCases,
  type BaselineField,
  type BaselineOptions,
  type BaselineResult,
  type CaseBaseline,
  type NormalizerProposal,
  type ProposableNormalizer,
} from './baseline.js';
export { appendNormalizers, normalizerEntry, setCorpusSettings } from './config-edit.js';
export {
  DEFAULT_GENERATOR_SEED,
  GENERATED_CORPUS_FILE,
  SEEDS_DIR,
  generatedCorpusKey,
  generatedCorpusSettings,
  readGeneratedCorpusCache,
  readSeedFixtures,
  writeGeneratedCorpusCache,
  type GeneratedCorpusCache,
  type GeneratedCorpusKeyInput,
  type GeneratedCorpusSettings,
} from './generated-corpus.js';
export { BASELINE_RECORD_FILE, baselineRecord, readBaselineRecord, writeBaselineRecord, type BaselineRecord } from './baseline-record.js';
export {
  FingerprintSchema,
  environmentFingerprint,
  fingerprintDifferences,
  localFingerprintHost,
  type Fingerprint,
  type FingerprintHost,
  type FingerprintOptions,
} from './fingerprint.js';
export {
  MANIFEST_FILE,
  checkManifest,
  manifestCases,
  manifestGenerator,
  manifestNormalizers,
  manifestPath,
  observationHash,
  readManifest,
  referenceObservationHashes,
  writeManifest,
  type Manifest,
  type ManifestCase,
  type ManifestCheck,
  type ManifestProblem,
  type ManifestState,
  type ObservationHashOptions,
  type ObserveReferenceOptions,
} from './manifest.js';
export {
  LARGE_WAIVER_SHARE,
  WAIVERS_FILE,
  WAIVER_CATEGORIES,
  WaiverSchema,
  describeWaiver,
  matchWaivers,
  parseWaivers,
  readWaiversFile,
  suggestWaivers,
  suggestedPredicates,
  suggestionReach,
  waiverCoverage,
  type ClusterReach,
  type RunCluster,
  type SuggestionSource,
  type WaivableDivergence,
  type Waiver,
  type WaiverCoverage,
  type WaiverMatch,
  type WaiverPredicate,
} from './waivers.js';
export {
  HISTORY_FILE,
  HISTORY_GITATTRIBUTES,
  HistoryEntrySchema,
  appendHistory,
  gitHead,
  historyPath,
  readHistory,
  type History,
  type HistoryEntry,
} from './history.js';
export { GITIGNORED, initProject, type InitOptions, type InitStep } from './init.js';
export {
  DEFAULT_STRENGTH_MUTANTS,
  applyMutant,
  isMutableSource,
  parseElementsReport,
  sampleMutants,
  scoreMutants,
  sourceMutants,
  type MutantResult,
  type MutantStatus,
  type SourceMutant,
  type StrengthScore,
} from './strength.js';

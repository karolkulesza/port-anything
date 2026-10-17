/** Name of this package, as published on npm. */
export const PACKAGE_NAME = '@port-anything/mcp';

export { SERVER_NAME, createServer, runSelection } from './server.js';
export { FEATURE_ROWS, STATUS_CHARACTERS, STATUS_CLUSTERS, cut, formatCase, formatFeatures, formatNext, formatProbe, formatRun, formatStatus, lineDiff } from './format.js';
export type {
  Backend,
  CandidateDelta,
  CandidateStatus,
  CaseReport,
  ClusterSummary,
  FeatureRow,
  FeaturesReport,
  FieldDiff,
  NextReport,
  ObservedText,
  ProbeInput,
  ProbeReport,
  ReproCase,
  RunDelta,
  RunSelection,
  StatusReport,
} from './types.js';

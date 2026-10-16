/** Name of this package, as published on npm. */
export const PACKAGE_NAME = '@port-anything/mcp';

export { SERVER_NAME, createServer, runSelection } from './server.js';
export { STATUS_CHARACTERS, STATUS_CLUSTERS, cut, formatNext, formatRun, formatStatus, lineDiff } from './format.js';
export type { Backend, CandidateDelta, CandidateStatus, ClusterSummary, FieldDiff, NextReport, ReproCase, RunDelta, RunSelection, StatusReport } from './types.js';

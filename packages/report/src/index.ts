/** Name of this package, as published on npm. */
export const PACKAGE_NAME = '@port-anything/report';

export { percent, renderReportHtml, type ReportCandidate, type ReportCandidateHoldout, type ReportHoldout, type ReportInput, type ReportRepro, type ReproContent } from './html.js';
export { badgeText, renderBadgeSvg, shortCount } from './badge.js';
export { ReportJsonSchema, reportJson, reportJsonSchema, type ReportJson } from './json.js';

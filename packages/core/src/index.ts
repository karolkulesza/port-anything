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

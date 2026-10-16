import type { ComparedField, InlineContent } from '@port-anything/core';

/** A cluster of a saved run, as the tools show it. */
export interface ClusterSummary {
  /** The run it belongs to; the cluster is `<run>/<cluster>`. */
  run: string;
  /** Its number in the run, from 1. */
  cluster: number;
  /** Its candidate, from 1. */
  candidate: number;
  size: number;
  /** The signature in words (see `describeSignature`). */
  description: string;
  /** Its cases' features with how many cases carry each, most first. */
  features: readonly { feature: string; cases: number }[];
}

/** One candidate's numbers in the latest run of the whole corpus. */
export interface CandidateStatus {
  candidate: number;
  command: string;
  /** Mean of per-feature parity; null when no feature has enough scored cases. */
  parity: number | null;
  /** Features in the parity. */
  features: number;
  match: number;
  diverge: number;
  waived: number;
}

/** What the `status` tool shows. */
export interface StatusReport {
  /** The latest saved run of the whole corpus; null when there is none. */
  run: { id: string; created: string; cases: number; programName: string; sandbox: string; compare: string } | null;
  candidates: readonly CandidateStatus[];
  /** `open` leaves out the clusters a later re-run of the cluster found fixed; `top` are the first open ones by priority. */
  clusters: { total: number; open: number; top: readonly ClusterSummary[] };
  integrity: {
    /** The frozen manifest (`port-anything baseline`); null when the corpus isn't frozen. */
    manifest: { cases: number; environment: 'same' | 'unknown' | { differs: readonly string[] } } | null;
    /** Cases left out because the reference varied in the baseline. */
    flakyReference: number;
    waivers: number;
    /** Waivers covering more than `LARGE_WAIVER_SHARE` of a candidate's cases. */
    largeWaivers: number;
    normalizers: readonly { normalizer: string; cases: number }[];
  };
}

/** A case written out with its content inline, ready to run by hand. */
export interface ReproCase {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: InlineContent | null;
  fixtures: Readonly<Record<string, InlineContent>>;
}

/** One diverging field of a case, both sides after the normalizers, as text. */
export interface FieldDiff {
  field: ComparedField;
  reference: string;
  candidate: string;
}

/** What the `next` tool shows. */
export type NextReport =
  | { kind: 'no-run' }
  | { kind: 'none-open'; run: string; total: number }
  | {
      kind: 'cluster';
      cluster: ClusterSummary;
      /** Open clusters, this one included. */
      open: number;
      programName: string;
      repro: ReproCase & {
        /** The cluster's case it comes from. */
        source: string;
        /** False when minimizing isn't possible (the source no longer diverges this way): the case is the source. */
        minimized: boolean;
        /** Minimizing stopped at its run budget, so a smaller repro may exist. */
        exhausted: boolean;
      };
      /** The repro's diverging fields now; empty when it no longer diverges. */
      diff: readonly FieldDiff[];
    };

/** The part of the corpus the `run` tool runs. */
export type RunSelection = { smoke: true } | { cluster: string } | { feature: string } | { cases: readonly string[] };

/** One candidate's result in a run, with what changed since the baseline run. */
export interface CandidateDelta {
  candidate: number;
  command: string;
  match: number;
  diverge: number;
  waived: number;
  /** Cases that diverged in the baseline run and no longer do; null without a baseline run of this candidate. */
  fixed: number | null;
  /** Cases that diverge now and didn't diverge in the baseline run (or weren't in it); null without a baseline. */
  broke: number | null;
  /** A few of the cases that broke, short IDs. */
  brokeCases: readonly string[];
}

/** What the `run` tool shows. */
export interface RunDelta {
  run: string;
  /** The part of the corpus run, in words. */
  selection: string;
  cases: number;
  /** The run of the whole corpus the deltas compare against; null when there was none. */
  baseline: string | null;
  flakyReference: number;
  candidates: readonly CandidateDelta[];
  clusters: { total: number; top: readonly ClusterSummary[] };
}

/** What the tools read and run; `port-anything mcp` implements it over a project directory. */
export interface Backend {
  status(): Promise<StatusReport>;
  next(): Promise<NextReport>;
  run(selection: RunSelection): Promise<RunDelta>;
}

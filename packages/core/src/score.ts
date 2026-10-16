import { caseFeatures } from './cluster.js';
import { ORIGINS, type Case } from './model.js';

type Origin = Case['origin'];

/** One case of one candidate, as scoring sees it. */
export interface ScoredCase {
  caseId: string;
  /** The case's feature tags; a case without tags counts toward `base`. */
  features: readonly string[];
  origin: Origin;
  /** Of the normalized observations, under the strictness profile. */
  verdict: 'match' | 'diverge';
  /** A waiver covers its divergence: left out of the score, never counted as a pass. */
  waived?: boolean | undefined;
  /** The reference itself varies on this case: left out of the score. */
  flakyReference?: boolean | undefined;
  /** The candidate gave a different result on a re-run: a divergence, whatever the verdict. */
  flakyCandidate?: boolean | undefined;
  /** The candidate ran out of time where the reference finished: a divergence, whatever the verdict. */
  candidateTimeout?: boolean | undefined;
}

/** A feature the CLI spec defines (see the spec's feature list). */
export interface KnownFeature {
  name: string;
  /** Marked `self_description: true` in the spec. */
  selfDescription: boolean;
}

export interface ScoreOptions {
  /** Features with fewer scored cases are shown but left out of the headline (`corpus.min_cases_per_feature`). */
  minCasesPerFeature?: number;
  /** The CLI spec's features, when there is a spec: for self-description marks and untested features. */
  features?: readonly KnownFeature[];
}

export const DEFAULT_MIN_CASES_PER_FEATURE = 20;

/** Case counts, shared by a feature, an origin and the whole run. */
export interface CaseCounts {
  /** Every case, excluded ones included. */
  cases: number;
  /** The cases that count: all but waived and flaky-reference ones. */
  scored: number;
  match: number;
  diverge: number;
  waived: number;
  flakyReference: number;
  /** Of the diverging cases, those where the candidate was flaky. */
  flakyCandidate: number;
  /** Of the diverging cases, those where the candidate timed out. */
  timeouts: number;
}

export interface FeatureScore extends CaseCounts {
  feature: string;
  /** `match / scored`; null when no case counts. */
  parity: number | null;
  /** `--help`, `--version`, `--usage` or marked in the spec: reported on its own, out of the headline. */
  selfDescription: boolean;
  /** Fewer scored cases than the minimum (and not self-description): out of the headline. */
  underSampled: boolean;
  inHeadline: boolean;
}

export interface OriginScore {
  cases: number;
  scored: number;
  match: number;
  /** The headline's features that have a scored case of this origin. */
  features: number;
  /** Mean parity of those features over this origin's cases; null when there are none. */
  parity: number | null;
}

export interface Score {
  /** Mean of per-feature parity over the headline's features; null when no feature qualifies. */
  headline: number | null;
  headlineFeatures: string[];
  /** Every feature some case carries, by name. */
  features: FeatureScore[];
  selfDescription: string[];
  underSampled: string[];
  /** Spec features no case carries. Empty without a spec. */
  untested: string[];
  /** Counts over cases, each counted once; `parity` is `match / scored` (shown next to the headline, never instead of it). */
  raw: CaseCounts & { parity: number | null };
  /** Per origin, under the same rules as the headline. */
  origins: Record<Origin, OriginScore>;
  minCasesPerFeature: number;
}

const SELF_DESCRIPTION_NAMES = new Set(['help', 'version', 'usage']);

/**
 * A `help`, `version` or `usage` flag of the program or of a subcommand (`opt.help`,
 * `cmd.add.opt.version`), such a subcommand (`cmd.help`), or such a bare tag (`help`). Not a feature
 * that merely ends in one of those words, such as `error.usage` (usage errors). Other
 * self-description features come from the spec's marks.
 */
export function isSelfDescriptionFeature(feature: string): boolean {
  const match = /(?:^|(?:^|\.)(?:opt|cmd)\.)([^.]+)$/.exec(feature);
  return match !== null && SELF_DESCRIPTION_NAMES.has(match[1]!);
}

export type Outcome = 'match' | 'diverge' | 'waived' | 'flaky-reference';

/**
 * How a case counts. A flaky reference leaves it out. A flaky or timed-out candidate diverges, and
 * no waiver covers that: otherwise a port could answer randomly or hang on hard cases to have them
 * excluded. A waiver only covers a case that diverges.
 */
export function outcome(c: ScoredCase): Outcome {
  if (c.flakyReference === true) return 'flaky-reference';
  if (c.flakyCandidate === true || c.candidateTimeout === true) return 'diverge';
  if (c.verdict === 'match') return 'match';
  return c.waived === true ? 'waived' : 'diverge';
}

const emptyCounts = (): CaseCounts => ({ cases: 0, scored: 0, match: 0, diverge: 0, waived: 0, flakyReference: 0, flakyCandidate: 0, timeouts: 0 });

function add(counts: CaseCounts, c: ScoredCase, o: Outcome): void {
  counts.cases++;
  if (o === 'waived') counts.waived++;
  else if (o === 'flaky-reference') counts.flakyReference++;
  else {
    counts.scored++;
    if (o === 'match') counts.match++;
    else {
      counts.diverge++;
      if (c.flakyCandidate === true) counts.flakyCandidate++;
      if (c.candidateTimeout === true) counts.timeouts++;
    }
  }
}

const ratio = (match: number, scored: number) => (scored === 0 ? null : match / scored);
const mean = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Scores one candidate's run. The headline is the mean of per-feature parity, so each feature
 * weighs the same however many cases it has. Counting rules: a case counts once in each of its
 * features (one without tags in `base`); waived and flaky-reference cases are left out, flaky
 * candidates and candidate timeouts diverge; self-description features and features with fewer
 * scored cases than the minimum are reported but left out of the headline.
 */
export function scoreCandidate(cases: readonly ScoredCase[], options: ScoreOptions = {}): Score {
  const minCasesPerFeature = options.minCasesPerFeature ?? DEFAULT_MIN_CASES_PER_FEATURE;
  if (!Number.isInteger(minCasesPerFeature) || minCasesPerFeature < 1) throw new RangeError(`minCasesPerFeature must be an integer of at least 1, not ${minCasesPerFeature}`);
  const marked = new Set((options.features ?? []).filter((f) => f.selfDescription).map((f) => f.name));

  const raw = emptyCounts();
  const perFeature = new Map<string, CaseCounts>();
  const perOrigin = new Map<Origin, { counts: CaseCounts; features: Map<string, CaseCounts> }>(ORIGINS.map((o) => [o, { counts: emptyCounts(), features: new Map() }]));
  for (const c of cases) {
    const o = outcome(c);
    add(raw, c, o);
    const origin = perOrigin.get(c.origin)!;
    add(origin.counts, c, o);
    for (const f of caseFeatures(c.features)) {
      for (const map of [perFeature, origin.features]) {
        let counts = map.get(f);
        if (counts === undefined) map.set(f, (counts = emptyCounts()));
        add(counts, c, o);
      }
    }
  }

  const features: FeatureScore[] = [...perFeature.keys()].sort(byName).map((feature) => {
    const counts = perFeature.get(feature)!;
    const selfDescription = marked.has(feature) || isSelfDescriptionFeature(feature);
    const underSampled = !selfDescription && counts.scored < minCasesPerFeature;
    return { feature, ...counts, parity: ratio(counts.match, counts.scored), selfDescription, underSampled, inHeadline: !selfDescription && !underSampled };
  });
  const inHeadline = features.filter((f) => f.inHeadline);
  const origins = Object.fromEntries(
    [...perOrigin].map(([origin, { counts, features: originFeatures }]) => {
      const parities = inHeadline.flatMap((f) => {
        const p = originFeatures.get(f.feature);
        return p === undefined || p.scored === 0 ? [] : [p.match / p.scored];
      });
      return [origin, { cases: counts.cases, scored: counts.scored, match: counts.match, features: parities.length, parity: mean(parities) }];
    }),
  ) as Record<Origin, OriginScore>;

  return {
    headline: mean(inHeadline.map((f) => f.parity!)),
    headlineFeatures: inHeadline.map((f) => f.feature),
    features,
    selfDescription: features.filter((f) => f.selfDescription).map((f) => f.feature),
    underSampled: features.filter((f) => f.underSampled).map((f) => f.feature),
    untested: [...new Set((options.features ?? []).map((f) => f.name))].filter((name) => !perFeature.has(name)).sort(byName),
    raw: { ...raw, parity: ratio(raw.match, raw.scored) },
    origins,
    minCasesPerFeature,
  };
}

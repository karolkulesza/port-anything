import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Observation } from './model.js';
import { normalizePair, type NormalizerName, type NormalizerSpec, type ScopeEntry, type SideContext } from './normalize.js';
import { defaultConcurrency, defaultContainerConcurrency, mapPool } from './pool.js';
import { pinPrograms } from './program.js';
import { observeCase, openContainers, sideContexts, type RunCasesOptions } from './run-cases.js';

/** Runs of each case against the reference, unless configured (`corpus.repeats`) or passed. */
export const DEFAULT_REPEATS = 3;

/**
 * The normalizers `baseline` proposes for output that varies between runs, in the order they are
 * tried and added to the pipeline. `sort-lines` comes last, so it sorts lines already normalized.
 */
export const PROPOSABLE_NORMALIZERS = ['tmp-paths', 'iso-timestamps', 'pids', 'sort-lines'] as const satisfies readonly NormalizerName[];

export type ProposableNormalizer = (typeof PROPOSABLE_NORMALIZERS)[number];

/**
 * A part of an observation that can vary between runs: `exit`, `signal`, `timeout`, `fs` (which
 * paths were created, modified or deleted), `stdout`, `stderr`, or `file:<path>` (a created or
 * modified file's content). Only the last three can be normalized.
 */
export type BaselineField = 'exit' | 'signal' | 'timeout' | 'fs' | 'stdout' | 'stderr' | `file:${string}`;

export interface BaselineOptions extends Omit<RunCasesOptions, 'candidates' | 'onCase'> {
  /** Runs per case, each in a fresh sandbox and a different directory; at least 2. */
  repeats?: number;
}

export interface CaseBaseline {
  caseId: string;
  /** One per run, in run order. */
  observations: Observation[];
  /** Fields that varied between runs with the configured normalizers applied. */
  varied: BaselineField[];
  /** For each varying field that proposable normalizers make stable: the fewest that do, in pipeline order. */
  fixes: { field: BaselineField; normalizers: ProposableNormalizer[] }[];
  /** Fields that still vary with the configured and the proposed normalizers. */
  unstable: BaselineField[];
  /**
   * `stable`: nothing varied. `normalized`: what varied is covered by the proposed normalizers.
   * `flaky-reference`: something still varies; the case is excluded from scoring.
   */
  status: 'stable' | 'normalized' | 'flaky-reference';
}

export interface NormalizerProposal {
  /** Scoped to the fields it was needed for; no scope when that is stdout, stderr and every file. */
  spec: NormalizerSpec;
  /** How many cases have a field it is needed for. */
  cases: number;
}

export interface BaselineResult {
  /** The argv[0] the reference ran as. */
  programName: string;
  repeats: number;
  /** In the order of `BaselineOptions.cases`. */
  cases: CaseBaseline[];
  /** In `PROPOSABLE_NORMALIZERS` order; meant to be appended to the configured normalizers. */
  proposals: NormalizerProposal[];
  /**
   * Normalizers that would make cases stable but are not proposed, because they can't be confined
   * to those cases: `sort-lines` needed by a case without features would sort that field in every
   * case, hiding real ordering bugs. Those cases stay `flaky-reference`.
   */
  withheld: { name: ProposableNormalizer; cases: number }[];
}

/**
 * Runs every case against the reference `repeats` times, each run in a fresh sandbox with its own
 * directory, and finds what varies between runs. A varying output field is matched against the
 * proposable normalizers (the fewest that make it stable, tried after the configured ones); the
 * matches become proposals. A case that still varies with them is `flaky-reference`.
 */
export async function baselineCases(options: BaselineOptions): Promise<BaselineResult> {
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 2) throw new RangeError(`repeats must be an integer of at least 2, got ${repeats}`);
  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  const pinOptions = options.programName === undefined ? {} : { name: options.programName };
  const { name, sides } = await pinPrograms(join(workDir, 'programs'), [options.reference], pinOptions);
  const context = await sideContexts(workDir, [options.reference], name, sides);
  const configured = options.normalizers ?? [];
  const containers = openContainers(options, workDir);
  const observeOptions = { ...options, ...(containers === undefined ? {} : { containers }) };

  const runs = await mapPool(options.cases, options.concurrency ?? (options.sandbox.kind === 'container' ? defaultContainerConcurrency(1) : defaultConcurrency()), async (c, _index, slot) => {
    const observations: Observation[] = [];
    const contexts: SideContext[] = [];
    for (let run = 0; run < repeats; run++) {
      // A different path each run, so output that includes it varies as it would between machines.
      const caseDir = join(workDir, `slot-${slot}`, `run-${run}`);
      observations.push(await observeCase(c, caseDir, name, sides[0]!, observeOptions));
      contexts.push(context(0, caseDir));
    }
    const runs: Runs = { features: c.features, observations, contexts };
    const varied = await variedFields(runs, configured, options);
    const fixes: CaseBaseline['fixes'] = [];
    for (const field of varied.filter(normalizable)) {
      const normalizers = await smallestFix(runs, field, configured, options);
      if (normalizers !== undefined) fixes.push({ field, normalizers });
    }
    return { caseId: c.id, features: c.features, runs, varied, fixes };
  }).finally(() => containers?.close());

  const { proposals, withheld } = propose(runs, configured);
  const pipeline = [...configured, ...proposals.map((p) => p.spec)];
  const cases: CaseBaseline[] = [];
  for (const { caseId, runs: r, varied, fixes } of runs) {
    const unstable = varied.length === 0 ? [] : await variedFields(r, pipeline, options);
    const status = varied.length === 0 ? 'stable' : unstable.length === 0 ? 'normalized' : 'flaky-reference';
    cases.push({ caseId, observations: r.observations, varied, fixes, unstable, status });
  }
  return { programName: name, repeats, cases, proposals, withheld };
}

/** A case's runs and what normalizers need to know about each. */
interface Runs {
  features: readonly string[];
  observations: Observation[];
  contexts: SideContext[];
}

const normalizable = (field: BaselineField) => field === 'stdout' || field === 'stderr' || field.startsWith('file:');

/** Fields where some run differs from the first, after normalizing each pair (first, other). */
async function variedFields(runs: Runs, normalizers: readonly NormalizerSpec[], options: BaselineOptions): Promise<BaselineField[]> {
  const varied = new Set<BaselineField>();
  for (let run = 1; run < runs.observations.length; run++) {
    const pair = await normalizePair({
      normalizers,
      features: runs.features,
      reference: { observation: runs.observations[0]!, context: runs.contexts[0]! },
      candidate: { observation: runs.observations[run]!, context: runs.contexts[run]! },
      store: options.store,
    });
    for (const field of differingFields(pair.reference, pair.candidate)) varied.add(field);
  }
  return order([...varied]);
}

function differingFields(a: Observation, b: Observation): BaselineField[] {
  const fields: BaselineField[] = [];
  for (const field of ['exit', 'signal', 'timeout', 'stdout', 'stderr'] as const) if (a[field] !== b[field]) fields.push(field);
  const paths = (o: Observation) => JSON.stringify([Object.keys(o.fs.created).sort(), Object.keys(o.fs.modified).sort(), [...new Set(o.fs.deleted)].sort()]);
  if (paths(a) !== paths(b)) fields.push('fs');
  for (const kind of ['created', 'modified'] as const) {
    for (const [path, ref] of Object.entries(a.fs[kind])) {
      const other = b.fs[kind][path];
      if (other !== undefined && other !== ref) fields.push(`file:${path}`);
    }
  }
  return fields;
}

const FIELD_ORDER = ['exit', 'signal', 'timeout', 'fs', 'stdout', 'stderr'];
const order = (fields: BaselineField[]) =>
  fields.sort((a, b) => {
    const [x, y] = [FIELD_ORDER.indexOf(a), FIELD_ORDER.indexOf(b)];
    if (x !== y) return (x === -1 ? FIELD_ORDER.length : x) - (y === -1 ? FIELD_ORDER.length : y);
    return a < b ? -1 : a > b ? 1 : 0;
  });

/** The scope that covers exactly one output field (a file path with glob characters can't be written exactly). */
function fieldScope(field: BaselineField): ScopeEntry {
  if (field === 'stdout' || field === 'stderr') return field;
  const path = field.slice('file:'.length);
  return /[*?]/.test(path) ? 'files' : `files:${path}`;
}

/** Proposable normalizers already configured for every field and case; proposing them again would change nothing. */
function alreadyEverywhere(configured: readonly NormalizerSpec[]): Set<NormalizerName> {
  return new Set(configured.filter((s) => s.scope === undefined && s.features === undefined).map((s) => s.name));
}

/**
 * The fewest proposable normalizers that, appended to the configured ones and scoped to this
 * field, make the field the same in every run; the first such set in pipeline order. Undefined
 * when none does.
 */
async function smallestFix(
  runs: Runs,
  field: BaselineField,
  configured: readonly NormalizerSpec[],
  options: BaselineOptions,
): Promise<ProposableNormalizer[] | undefined> {
  const skip = alreadyEverywhere(configured);
  const names = PROPOSABLE_NORMALIZERS.filter((n) => !skip.has(n));
  const subsets: ProposableNormalizer[][] = [];
  for (let mask = 1; mask < 1 << names.length; mask++) subsets.push(names.filter((_, i) => mask & (1 << i)));
  subsets.sort((a, b) => a.length - b.length); // stable: same size keeps pipeline order
  for (const subset of subsets) {
    const extra = subset.map((name): NormalizerSpec => ({ name, options: {}, scope: [fieldScope(field)] }));
    if (!(await variedFields(runs, [...configured, ...extra], options)).includes(field)) return subset;
  }
  return undefined;
}

const DEFAULT_PROPOSAL_SCOPE = ['stdout', 'stderr', 'files'];

/**
 * One proposal per normalizer some case needs, scoped to the union of the fields it was needed for.
 * `sort-lines` hides every line-order difference in its scope, so it is also scoped to the features
 * of the cases that need it, and withheld when one of them has no features.
 */
function propose(
  runs: readonly { caseId: string; features: readonly string[]; fixes: CaseBaseline['fixes'] }[],
  configured: readonly NormalizerSpec[],
): Pick<BaselineResult, 'proposals' | 'withheld'> {
  const skip = alreadyEverywhere(configured);
  const proposals: NormalizerProposal[] = [];
  const withheld: BaselineResult['withheld'] = [];
  for (const name of PROPOSABLE_NORMALIZERS) {
    if (skip.has(name)) continue;
    const scopes = new Set<ScopeEntry>();
    const cases = new Set<string>();
    const features = new Set<string>();
    let featureless = false;
    for (const { caseId, features: caseFeatures, fixes } of runs) {
      for (const fix of fixes) {
        if (!fix.normalizers.includes(name)) continue;
        scopes.add(fieldScope(fix.field));
        cases.add(caseId);
        for (const f of caseFeatures) features.add(f);
        if (caseFeatures.length === 0) featureless = true;
      }
    }
    if (cases.size === 0) continue;
    const byFeature = name === 'sort-lines';
    if (byFeature && featureless) {
      withheld.push({ name, cases: cases.size });
      continue;
    }
    // `files` covers each `files:<path>`.
    const scope = [...scopes].filter((s) => !(scopes.has('files') && s.startsWith('files:'))).sort((a, b) => {
      const [x, y] = [DEFAULT_PROPOSAL_SCOPE.indexOf(a), DEFAULT_PROPOSAL_SCOPE.indexOf(b)];
      if (x !== y) return (x === -1 ? 3 : x) - (y === -1 ? 3 : y);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const everywhere = DEFAULT_PROPOSAL_SCOPE.every((s) => scope.includes(s as ScopeEntry));
    proposals.push({
      spec: { name, options: {}, ...(everywhere ? {} : { scope }), ...(byFeature ? { features: [...features].sort() } : {}) },
      cases: cases.size,
    });
  }
  return { proposals, withheld };
}

import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { BlobStore } from './blob-store.js';
import { compareExact, compareObservations, type ComparedField, type CompareOptions, type Comparison } from './compare.js';
import { ContainerPool } from './container.js';
import { classifyDiff, type FieldShape } from './diff-shape.js';
import { fsChanges } from './fs-diff.js';
import { canonicalObservation, type CanonicalCase, type Observation } from './model.js';
import { normalizePair, type NormalizerSpec, type SideContext } from './normalize.js';
import { defaultConcurrency, mapPool } from './pool.js';
import { caseEnvironment, runProcess } from './process-runner.js';
import { pinPrograms, pinnedProcess, type PinnedProgram, type ResolvedProgram } from './program.js';
import type { SandboxSetup } from './sandbox.js';

export interface RunCasesOptions {
  reference: ResolvedProgram;
  /** Any number of candidates; each is compared against the same reference observation. */
  candidates: readonly ResolvedProgram[];
  cases: readonly CanonicalCase[];
  /** Holds the cases' stdin and fixtures; captured output and small created files are added to it. */
  store: BlobStore;
  sandbox: SandboxSetup;
  /**
   * Scratch directory for the pinned programs and the cases' working directories; created if
   * needed. The caller removes it. Under bwrap it may be anywhere, /tmp included.
   */
  workDir: string;
  /** The argv[0] every side runs as (`program_name`); see `defaultProgramName` for the default. */
  programName?: string;
  /** Cases running at once. Defaults to the number of CPU cores. */
  concurrency?: number;
  timeoutMs?: number;
  outputCapBytes?: number;
  /** Host variables passed through (`sandbox.env_allowlist`). */
  envAllowlist?: readonly string[];
  /** Overrides of the default case variables (`sandbox.env`). */
  env?: Readonly<Record<string, string>>;
  /** Defaults to this process's environment. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Applied in order to both sides before each comparison (`normalizers` in the config). */
  normalizers?: readonly NormalizerSpec[];
  /** Strictness profile and stderr mode (`compare` in the config). Defaults to the standard profile. */
  compare?: CompareOptions;
  /** Called as each case finishes (in completion order, not case order). */
  onCase?: (result: CaseRun) => void;
  /**
   * Re-run a candidate once on each case it diverges on, to tell flaky-candidate cases apart.
   * Defaults to true; the minimizer turns it off, since it only needs the first run's signature.
   */
  rerun?: boolean;
  /**
   * On a case some candidate diverges on, run the reference up to this many more times, stopping at
   * the first run that observes something else than the first once both are normalized (see
   * `CaseRun.referenceVaried`). A baseline of a few runs can miss output that varies by chance, such
   * as a random sort of two lines; this catches it where it would count. A re-check that times out
   * where the first run didn't is no answer and doesn't count as varying. Defaults to 0 (off).
   */
  recheckReference?: number;
}

/** One candidate's observation of a case and how it compares with the reference's. */
export interface CandidateRun {
  /**
   * The observation compared: the first run's, or the re-run's when `timeoutRecovered`. After a
   * re-run, `runs` is 2 and `stable` says whether the re-run observed the same.
   */
  observation: Observation;
  /** Of the normalized observations, under the strictness profile. */
  comparison: Comparison;
  /** The shape of each diverging field of the normalized observations, for clustering; empty for a match. */
  shapes: FieldShape[];
  /** Indexes into `RunCasesOptions.normalizers` of those that changed either side of this comparison. */
  normalizedBy: number[];
  /** Both observations as compared, after the normalizers (for waivers' regexes and diffs). */
  normalized: { reference: Observation; candidate: Observation };
  /** The re-run's observation; only a diverging case is re-run. */
  rerun?: Observation;
  /**
   * `flaky-candidate`: the case diverged and its re-run observed something else, once both were
   * normalized and compared under the same profile. It still counts as a divergence (otherwise a
   * port could answer at random on cases it can't handle and have them dropped), but is kept out of
   * clustering and listed on its own.
   */
  flaky: boolean;
  /**
   * The first run timed out where the reference finished, and the re-run finished: a timeout isn't
   * an answer (a stall on a busy machine), so the re-run is the observation compared and the case
   * isn't flaky. A real hang times out on the re-run too and is compared as it was.
   */
  timeoutRecovered: boolean;
  /** The first run's timed-out observation, when `timeoutRecovered`. */
  firstRun?: Observation;
}

export interface CaseRun {
  caseId: string;
  reference: Observation;
  /** In the order of `RunCasesOptions.candidates`. */
  candidates: CandidateRun[];
  /**
   * Fields a re-check of the reference (`RunCasesOptions.recheckReference`) observed differently
   * from its first run, after the normalizers; absent when it observed the same or didn't run. The
   * reference isn't stable on this case, so it can't be scored.
   */
  referenceVaried?: ComparedField[];
}

export interface RunCasesResult {
  /** The argv[0] every side ran as. */
  programName: string;
  /** In the order of `RunCasesOptions.cases`. */
  cases: CaseRun[];
}

/**
 * Runs every case against the reference once, then against each candidate, and compares each
 * candidate's observation with the reference's under the strictness profile, once both have been
 * normalized. A candidate that diverges on a case runs it once more, to tell a racy port (`flaky`)
 * from a steady divergence or, when its first run timed out, to compare an answer instead
 * (`timeoutRecovered`). Cases run in a worker pool; within a case the sides run one after another,
 * in the same working directory path (also HOME), so a program that prints its directory doesn't
 * diverge for that alone.
 */
export async function runCases(options: RunCasesOptions): Promise<RunCasesResult> {
  const runner = await openCaseRunner(options);
  try {
    const cases = await mapPool(options.cases, options.concurrency ?? defaultConcurrency(), async (c, _index, slot) => {
      const result = await runner.run(c, slot);
      options.onCase?.(result);
      return result;
    });
    return { programName: runner.programName, cases };
  } finally {
    await runner.close();
  }
}

/** The programs of a run, pinned once, to run cases on one at a time or from a worker pool. */
export interface CaseRunner {
  /** The argv[0] every side runs as. */
  programName: string;
  /**
   * Runs one case on the reference and every candidate and compares them, as `runCases` does. Calls
   * that run at the same time need different slots (each slot is one scratch directory).
   */
  run(c: CanonicalCase, slot?: number): Promise<CaseRun>;
  /** Stops what the runner started (in sandbox mode `container`, its containers). */
  close(): Promise<void>;
}

/**
 * Pins the reference and candidates under `options.workDir` for running cases one by one (as the
 * minimizer does); `options.cases`, `concurrency` and `onCase` are not used. In sandbox mode
 * `container`, each side gets a long-lived container per slot, started on first use; `close` stops them.
 */
export async function openCaseRunner(options: Omit<RunCasesOptions, 'cases' | 'concurrency' | 'onCase'>): Promise<CaseRunner> {
  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  const programs = [options.reference, ...options.candidates];
  const pinOptions = options.programName === undefined ? {} : { name: options.programName };
  const { name, sides } = await pinPrograms(join(workDir, 'programs'), programs, pinOptions);
  const context = await sideContexts(workDir, programs, name, sides);
  const containers = openContainers(options, workDir);
  const observeOptions = { ...options, ...(containers === undefined ? {} : { containers }) };

  const run = async (c: CanonicalCase, slot = 0): Promise<CaseRun> => {
    const caseDir = join(workDir, `slot-${slot}`, 'case');
    const observe = (side: PinnedProgram) => observeCase(c, caseDir, name, side, observeOptions);
    const reference = await observe(sides[0]!);
    const candidates: CandidateRun[] = [];
    for (const [i, side] of sides.entries()) {
      if (i === 0) continue;
      const observation = await observe(side);
      const compare = async (left: { observation: Observation; side: number }, right: Observation) => {
        const normalized = await normalizePair({
          normalizers: options.normalizers ?? [],
          features: c.features,
          reference: { observation: left.observation, context: context(left.side, caseDir) },
          candidate: { observation: right, context: context(i, caseDir) },
          store: options.store,
        });
        const comparison = await compareObservations(normalized.reference, normalized.candidate, {
          ...(options.compare ?? { profile: 'standard' }),
          store: options.store,
          programNames: { reference: context(left.side, caseDir).programNames, candidate: context(i, caseDir).programNames },
        });
        return { normalized, comparison };
      };
      const result = async (observed: Observation, first: Awaited<ReturnType<typeof compare>>) => {
        const { normalized, comparison } = first;
        const shapes = comparison.verdict === 'match' ? [] : await classifyDiff(normalized.reference, normalized.candidate, comparison.fields, options.store);
        return { observation: observed, comparison, shapes, normalizedBy: normalized.changedBy, normalized: { reference: normalized.reference, candidate: normalized.candidate } };
      };
      const first = await compare({ observation: reference, side: 0 }, observation);
      if (first.comparison.verdict === 'match' || options.rerun === false) {
        candidates.push({ ...(await result(observation, first)), flaky: false, timeoutRecovered: false });
        continue;
      }
      const rerun = await observe(side);
      if (observation.timeout && !reference.timeout && !rerun.timeout) {
        const again = await result({ ...rerun, runs: 2, stable: false }, await compare({ observation: reference, side: 0 }, rerun));
        candidates.push({ ...again, rerun, flaky: false, timeoutRecovered: true, firstRun: observation });
        continue;
      }
      const flaky = (await compare({ observation, side: i }, rerun)).comparison.verdict === 'diverge';
      candidates.push({ ...(await result({ ...observation, runs: 2, stable: !flaky }, first)), rerun, flaky, timeoutRecovered: false });
    }
    const recheck = options.recheckReference ?? 0;
    if (recheck > 0 && candidates.some((run) => run.comparison.verdict === 'diverge')) {
      for (let n = 0; n < recheck; n++) {
        const again = await observe(sides[0]!);
        // A stall isn't an answer: a re-check that timed out where the first run finished says nothing.
        if (again.timeout && !reference.timeout) continue;
        const pair = await normalizePair({
          normalizers: options.normalizers ?? [],
          features: c.features,
          reference: { observation: reference, context: context(0, caseDir) },
          candidate: { observation: again, context: context(0, caseDir) },
          store: options.store,
        });
        const { fields } = compareExact(pair.reference, pair.candidate);
        if (fields.length > 0) return { caseId: c.id, reference, candidates, referenceVaried: fields };
      }
    }
    return { caseId: c.id, reference, candidates };
  };
  return { programName: name, run, close: async () => containers?.close() };
}

/** In sandbox mode `container`, the pool of containers cases run in; undefined otherwise. */
export function openContainers(options: Pick<RunCasesOptions, 'sandbox' | 'timeoutMs' | 'outputCapBytes'>, workDir: string): ContainerPool | undefined {
  if (options.sandbox.kind !== 'container') return undefined;
  return new ContainerPool({
    setup: options.sandbox,
    dir: join(workDir, 'containers'),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputCapBytes === undefined ? {} : { outputCapBytes: options.outputCapBytes }),
  });
}

/**
 * What normalizers need to know about each side of a run, given its case directory: paths a side
 * may print that differ between sides or runs (as given and with links resolved), and its names.
 */
export async function sideContexts(
  workDir: string,
  programs: readonly ResolvedProgram[],
  name: string,
  sides: readonly PinnedProgram[],
): Promise<(side: number, caseDir: string) => SideContext> {
  const realWorkDir = await realpath(workDir);
  const spellings = (path: string) => [path, join(realWorkDir, relative(workDir, path))];
  const programNames = programs.map((p) => [name, basename(p.path), basename(p.realPath), ...(p.tool === undefined ? [] : [p.tool])]);
  return (side, caseDir) => ({
    tempRoots: [caseDir, sides[side]!.binDir, workDir].flatMap(spellings),
    programNames: programNames[side]!,
  });
}

/** The options `observeCase` reads. */
export type ObserveOptions = Pick<RunCasesOptions, 'store' | 'sandbox' | 'timeoutMs' | 'outputCapBytes' | 'envAllowlist' | 'env' | 'hostEnv'> & {
  /** Required in sandbox mode `container`: the containers to run in (see `openContainers`). */
  containers?: ContainerPool;
};

/**
 * Runs one side on one case in a fresh copy of the case's directory and builds its observation. In
 * sandbox mode `container`, the case directory is at that path in the side's container, on a tmpfs,
 * and the case gets the image's PATH instead of the host's.
 */
export async function observeCase(
  c: CanonicalCase,
  caseDir: string,
  name: string,
  side: PinnedProgram,
  options: ObserveOptions,
): Promise<Observation> {
  const { store } = options;
  if (options.sandbox.kind === 'container' && options.containers === undefined) throw new Error('Sandbox mode "container" needs a container pool.');
  const prepared = options.containers === undefined ? undefined : await (await options.containers.session(side, caseDir)).prepare(caseDir);
  const hostDir = prepared === undefined ? caseDir : prepared.files;
  await rm(hostDir, { recursive: true, force: true });
  await mkdir(hostDir, { recursive: true });
  for (const [path, ref] of Object.entries(c.fixtures)) {
    const file = join(hostDir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await store.get(ref));
  }
  const stdin = c.stdin === null ? null : await store.get(c.stdin);
  const hostEnv = options.hostEnv ?? process.env;
  const env = caseEnvironment({
    home: caseDir,
    ...(options.envAllowlist === undefined ? {} : { allowlist: options.envAllowlist }),
    ...(options.env === undefined ? {} : { env: options.env }),
    hostEnv: prepared === undefined ? hostEnv : { ...hostEnv, PATH: await options.containers!.imagePath() },
    caseEnv: c.env,
  });
  const limits = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputCapBytes === undefined ? {} : { outputCapBytes: options.outputCapBytes }),
  };
  const proc = { ...pinnedProcess(name, side, c.argv, env), cwd: caseDir, stdin };
  let result;
  let fs;
  if (prepared === undefined) {
    result = await runProcess({ ...proc, sandbox: options.sandbox, ...limits });
    fs = await fsChanges(caseDir, c.fixtures, { store });
  } else {
    try {
      result = await prepared.run(proc, limits);
      fs = await fsChanges(result.result, c.fixtures, { store });
    } finally {
      await prepared.dispose();
    }
  }
  return canonicalObservation({
    exit: result.exit,
    signal: result.signal,
    timeout: result.timeout,
    stdout: await store.put(result.stdout),
    stderr: await store.put(result.stderr),
    fs,
    time_ms: result.time_ms,
    rss_kb: result.rss_kb,
    runs: 1,
    stable: true,
  });
}

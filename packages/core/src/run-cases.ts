import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { BlobStore } from './blob-store.js';
import { compareExact, type Comparison } from './compare.js';
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
  /** Called as each case finishes (in completion order, not case order). */
  onCase?: (result: CaseRun) => void;
}

/** One candidate's observation of a case and how it compares with the reference's. */
export interface CandidateRun {
  observation: Observation;
  /** Of the normalized observations. */
  comparison: Comparison;
  /** Indexes into `RunCasesOptions.normalizers` of those that changed either side of this comparison. */
  normalizedBy: number[];
}

export interface CaseRun {
  caseId: string;
  reference: Observation;
  /** In the order of `RunCasesOptions.candidates`. */
  candidates: CandidateRun[];
}

export interface RunCasesResult {
  /** The argv[0] every side ran as. */
  programName: string;
  /** In the order of `RunCasesOptions.cases`. */
  cases: CaseRun[];
}

/**
 * Runs every case against the reference once, then against each candidate, and compares each
 * candidate's observation with the reference's, exactly once both have been normalized. Cases run in a worker pool;
 * within a case the sides run one after another, in the same working directory path (also HOME),
 * so a program that prints its directory doesn't diverge for that alone.
 */
export async function runCases(options: RunCasesOptions): Promise<RunCasesResult> {
  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  const programs = [options.reference, ...options.candidates];
  const pinOptions = options.programName === undefined ? {} : { name: options.programName };
  const { name, sides } = await pinPrograms(join(workDir, 'programs'), programs, pinOptions);
  // Paths a side may print that differ between sides or runs, as given and with links resolved.
  const realWorkDir = await realpath(workDir);
  const spellings = (path: string) => [path, join(realWorkDir, relative(workDir, path))];
  const programNames = programs.map((p) => [name, basename(p.path), basename(p.realPath), ...(p.tool === undefined ? [] : [p.tool])]);
  const context = (side: number, caseDir: string): SideContext => ({
    tempRoots: [caseDir, sides[side]!.binDir, workDir].flatMap(spellings),
    programNames: programNames[side]!,
  });

  const cases = await mapPool(options.cases, options.concurrency ?? defaultConcurrency(), async (c, _index, slot) => {
    const caseDir = join(workDir, `slot-${slot}`, 'case');
    const observe = (side: PinnedProgram) => observeCase(c, caseDir, name, side, options);
    const reference = await observe(sides[0]!);
    const candidates: CandidateRun[] = [];
    for (const [i, side] of sides.entries()) {
      if (i === 0) continue;
      const observation = await observe(side);
      const normalized = await normalizePair({
        normalizers: options.normalizers ?? [],
        features: c.features,
        reference: { observation: reference, context: context(0, caseDir) },
        candidate: { observation, context: context(i, caseDir) },
        store: options.store,
      });
      candidates.push({ observation, comparison: compareExact(normalized.reference, normalized.candidate), normalizedBy: normalized.changedBy });
    }
    const result: CaseRun = { caseId: c.id, reference, candidates };
    options.onCase?.(result);
    return result;
  });
  return { programName: name, cases };
}

/** Runs one side on one case in a fresh copy of the case's directory and builds its observation. */
async function observeCase(
  c: CanonicalCase,
  caseDir: string,
  name: string,
  side: PinnedProgram,
  options: RunCasesOptions,
): Promise<Observation> {
  const { store } = options;
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(caseDir, { recursive: true });
  for (const [path, ref] of Object.entries(c.fixtures)) {
    const file = join(caseDir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await store.get(ref));
  }
  const stdin = c.stdin === null ? null : await store.get(c.stdin);
  const env = caseEnvironment({
    home: caseDir,
    ...(options.envAllowlist === undefined ? {} : { allowlist: options.envAllowlist }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.hostEnv === undefined ? {} : { hostEnv: options.hostEnv }),
    caseEnv: c.env,
  });
  const result = await runProcess({
    ...pinnedProcess(name, side, c.argv, env),
    cwd: caseDir,
    stdin,
    sandbox: options.sandbox,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputCapBytes === undefined ? {} : { outputCapBytes: options.outputCapBytes }),
  });
  const fs = await fsChanges(caseDir, c.fixtures, { store });
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

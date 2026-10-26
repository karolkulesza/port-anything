import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  CONFIG_FILE,
  ConfigError,
  DEFAULT_REPEATS,
  MANIFEST_FILE,
  SandboxUnavailableError,
  appendNormalizers,
  baselineCases,
  baselineRecord,
  cacheDir,
  caseEnvironment,
  chooseSandbox,
  generatedCorpusSettings,
  manifestCases,
  manifestGenerator,
  manifestNormalizers,
  normalizerLabel,
  parseConfigSource,
  probeSandbox,
  readConfigFile,
  shortCaseId,
  writeBaselineRecord,
  writeManifest,
  type CanonicalCase,
  type Config,
  type SandboxProbe,
} from '@port-anything/core';
import { display, prepareContainer, resolveCommand, sandboxFingerprint, withScratchDir, type CliResult } from './common.js';
import { loadCorpus, unknownFeatureTagsWarning } from './corpus.js';
import { TOOL_VERSION } from './version.js';

/** The options of `port-anything baseline`. */
export interface BaselineArgs {
  /** `--repeats N`; defaults to `corpus.repeats`, then 3. */
  repeats?: number;
  noSandbox: boolean;
}

export const USAGE = 'Usage: port-anything baseline [--repeats N] [--no-sandbox]';

/** Reads the arguments after `baseline`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseBaselineArgs(argv: readonly string[]): BaselineArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { repeats: { type: 'string' }, 'no-sandbox': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
  const args: BaselineArgs = { noSandbox: values['no-sandbox'] ?? false };
  if (values.repeats !== undefined) {
    if (!/^\d+$/.test(values.repeats) || Number(values.repeats) < 2) throw new ConfigError(`--repeats must be a whole number of at least 2, got "${values.repeats}".`);
    args.repeats = Number(values.repeats);
  }
  return args;
}

/**
 * `port-anything baseline` in a project directory: reads `port-anything.yaml` and the committed
 * cases there, then baselines them (see `executeBaseline`).
 */
export async function baselineCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  let prepared: ExecuteBaselineOptions;
  let warning: string | undefined;
  try {
    const args = parseBaselineArgs(argv);
    const config = await readConfigFile(options.cwd);
    const cases = await loadCorpus(options.cwd, config, { noSandbox: args.noSandbox, ...(options.probe === undefined ? {} : { probe: options.probe }) });
    warning = await unknownFeatureTagsWarning(options.cwd);
    prepared = { projectDir: options.cwd, config, cases, args, ...(options.probe === undefined ? {} : { probe: options.probe }) };
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
  const result = await executeBaseline(prepared);
  return warning === undefined ? result : { ...result, stderr: `port-anything baseline: ${warning}${result.stderr}` };
}

export interface ExecuteBaselineOptions {
  /** Holds `port-anything.yaml` (edited when normalizers are proposed) and `.port-anything/`. */
  projectDir: string;
  config: Config;
  /** Their stdin and fixtures must already be in the project's blob store. */
  cases: readonly CanonicalCase[];
  args: BaselineArgs;
  /** The sandbox probe's result; probed on this machine when absent. */
  probe?: SandboxProbe;
}

/**
 * Runs every case against the reference several times and reports what varied. Proposed
 * normalizers are appended to `port-anything.yaml` (an ordinary edit, to review in the diff); cases
 * that still vary are `flaky-reference`, recorded in the cache so `run` leaves them out. Then the
 * corpus is frozen in `.port-anything/MANIFEST.json` (committed; `verify` checks it): every case,
 * the hash of each stable observation, the generator settings, the normalizers and the environment
 * fingerprint. Exit code 0 when the baseline finished, 3 when it can't start (config, programs, sandbox).
 */
export async function executeBaseline(options: ExecuteBaselineOptions): Promise<CliResult> {
  try {
    return await execute(options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything baseline: ${message}\n` });

async function execute({ projectDir, config, cases, args, probe }: ExecuteBaselineOptions): Promise<CliResult> {
  if (cases.length === 0) throw new ConfigError('No cases to baseline: add some to port-anything/recorded/*.jsonl, or generate them with port-anything generate.');
  const sandbox =
    config.sandbox.mode === 'container'
      ? await prepareContainer(projectDir, config, [], { noSandbox: args.noSandbox })
      : chooseSandbox(probe ?? (await probeSandbox()), { noSandbox: args.noSandbox });
  const reference = await resolveCommand(config.reference.cmd, projectDir);
  const repeats = args.repeats ?? config.corpus?.repeats ?? DEFAULT_REPEATS;

  const result = await withScratchDir(projectDir, 'baseline', (workDir) =>
    baselineCases({
      reference,
      cases,
      store: new BlobStore(cacheDir(projectDir)),
      sandbox,
      workDir,
      repeats,
      ...(config.program_name === undefined ? {} : { programName: config.program_name }),
      timeoutMs: config.sandbox.timeout,
      envAllowlist: config.sandbox.env_allowlist,
      env: config.sandbox.env,
      normalizers: config.normalizers,
    }),
  );

  let normalizers = config.normalizers;
  if (result.proposals.length > 0) {
    const file = join(projectDir, CONFIG_FILE);
    const source = await readFile(file, 'utf8').catch((e: Error) => {
      throw new ConfigError(`Cannot read ${CONFIG_FILE} to add the proposed normalizers: ${e.message}`);
    });
    const plural = (n: number) => `${n} case${n === 1 ? '' : 's'}`;
    const edited = appendNormalizers(
      source,
      result.proposals.map((p) => ({ spec: p.spec, comment: `added by port-anything baseline: needed in ${plural(p.cases)}` })),
    );
    normalizers = parseConfigSource(edited).normalizers; // never leave a config that no longer loads
    await writeFile(file, edited);
  }
  await writeBaselineRecord(projectDir, baselineRecord(result));
  const caseEnv = caseEnvironment({ home: projectDir, allowlist: config.sandbox.env_allowlist, env: config.sandbox.env });
  await writeManifest(projectDir, {
    version: 1,
    tool_version: TOOL_VERSION,
    generator: manifestGenerator(generatedCorpusSettings(config)),
    normalizers: manifestNormalizers(normalizers),
    fingerprint: await sandboxFingerprint(sandbox, reference, caseEnv),
    cases: manifestCases(cases, new Map(result.cases.flatMap((c) => (c.observationHash === null ? [] : [[c.caseId, c.observationHash] as const])))),
  });

  const count = (status: string) => result.cases.filter((c) => c.status === status).length;
  const lines = [
    `Ran ${result.cases.length} case${result.cases.length === 1 ? '' : 's'} ${repeats} times each as "${result.programName}", sandbox: ${sandbox.label}`,
    `reference ${display(config.reference.cmd)}`,
    `stable: ${count('stable')}, stable after normalizers: ${count('normalized')}, flaky-reference: ${count('flaky-reference')}`,
  ];
  if (result.proposals.length === 0) lines.push('proposed normalizers: none');
  else {
    lines.push(`proposed normalizers, added to ${CONFIG_FILE} (cases that need them):`);
    for (const p of result.proposals) lines.push(`  ${normalizerLabel(p.spec)}: ${p.cases}`);
  }
  for (const w of result.withheld) {
    lines.push(`not proposed: ${w.name}, needed in ${w.cases} case${w.cases === 1 ? '' : 's'} without features; scoped to every case it would hide real differences in line order (tag those cases with features, or add it by hand)`);
  }
  const flaky = result.cases.filter((c) => c.status === 'flaky-reference');
  if (flaky.length > 0) {
    lines.push('flaky-reference, left out of run (fields that still vary):');
    for (const c of flaky) lines.push(`  ${shortCaseId(c.caseId)}  ${c.unstable.join(', ')}`);
  }
  lines.push(`froze the corpus in .port-anything/${MANIFEST_FILE}: commit it; port-anything verify checks it`);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

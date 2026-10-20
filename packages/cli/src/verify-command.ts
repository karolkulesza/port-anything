import { parseArgs } from 'node:util';
import {
  BlobStore,
  ConfigError,
  MANIFEST_FILE,
  SandboxUnavailableError,
  cacheDir,
  caseEnvironment,
  checkManifest,
  chooseSandbox,
  generatedCorpusSettings,
  manifestCases,
  manifestGenerator,
  manifestNormalizers,
  probeSandbox,
  readConfigFile,
  readManifest,
  referenceObservationHashes,
  shortCaseId,
  fingerprintField,
  type Fingerprint,
  type FingerprintField,
  type Manifest,
  type ManifestProblem,
  type SandboxProbe,
} from '@port-anything/core';
import { prepareContainer, resolveCommand, sandboxFingerprint, withScratchDir, type CliResult } from './common.js';
import { loadCorpus } from './corpus.js';
import { TOOL_VERSION } from './version.js';

/** The options of `port-anything verify`. */
export interface VerifyArgs {
  noSandbox: boolean;
}

export const USAGE = 'Usage: port-anything verify [--no-sandbox]';

/** Exit code of a broken manifest in the environment it was frozen in. */
export const INTEGRITY_BROKEN = 2;

/** Reads the arguments after `verify`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseVerifyArgs(argv: readonly string[]): VerifyArgs {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { 'no-sandbox': { type: 'boolean' } }, strict: true, allowPositionals: false }));
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
  return { noSandbox: values['no-sandbox'] ?? false };
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything verify: ${message}\n` });

/**
 * `port-anything verify` in a project directory: checks the corpus against the manifest
 * `baseline` froze. It regenerates the corpus as `run` does, runs the reference once on every case
 * the manifest has an observation for, and compares the generator settings, the normalizers, the
 * cases, their features and the observation hashes. Any difference on a machine with the manifest's
 * environment fingerprint is "INTEGRITY BROKEN", exit 2; with another fingerprint the reference may
 * legitimately behave differently, so it is a warning and exit 0. Exit 3 when it can't start.
 */
export async function verifyCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  try {
    return await execute(parseVerifyArgs(argv), options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

async function execute(args: VerifyArgs, { cwd, probe }: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  const config = await readConfigFile(cwd);
  const manifest = await readManifest(cwd);
  if (manifest === undefined) throw new ConfigError(`No .port-anything/${MANIFEST_FILE} to verify: freeze the corpus with port-anything baseline first.`);
  // In container mode the reference is built in the image first.
  const sandbox =
    config.sandbox.mode === 'container'
      ? await prepareContainer(cwd, config, [], { noSandbox: args.noSandbox })
      : chooseSandbox(probe ?? (await probeSandbox()), { noSandbox: args.noSandbox });
  const cases = await loadCorpus(cwd, config, { noSandbox: args.noSandbox, sandbox });
  const reference = await resolveCommand(config.reference.cmd, cwd);

  // Only cases with a frozen observation run: a flaky-reference case has nothing to compare with.
  const frozen = new Set(manifest.cases.filter((c) => c.observation !== null).map((c) => c.id));
  const toRun = cases.filter((c) => frozen.has(c.id));
  const hashes = await withScratchDir(cwd, 'verify', (workDir) =>
    referenceObservationHashes({
      reference,
      cases: toRun,
      store: new BlobStore(cacheDir(cwd)),
      sandbox,
      workDir,
      ...(config.program_name === undefined ? {} : { programName: config.program_name }),
      timeoutMs: config.sandbox.timeout,
      envAllowlist: config.sandbox.env_allowlist,
      env: config.sandbox.env,
      normalizers: config.normalizers,
    }),
  );
  const caseEnv = caseEnvironment({ home: cwd, allowlist: config.sandbox.env_allowlist, env: config.sandbox.env });
  const fingerprint = await sandboxFingerprint(sandbox, reference, caseEnv);
  const check = checkManifest(manifest, {
    generator: manifestGenerator(generatedCorpusSettings(config)),
    normalizers: manifestNormalizers(config.normalizers),
    cases: manifestCases(cases, hashes),
    fingerprint,
  });

  const lines = [`Checked ${cases.length} case${cases.length === 1 ? '' : 's'} against .port-anything/${MANIFEST_FILE}, re-running the reference on ${toRun.length}, sandbox: ${sandbox.label}`];
  if (manifest.tool_version !== TOOL_VERSION) lines.push(`frozen by port-anything ${manifest.tool_version}, checked with ${TOOL_VERSION}`);
  const sameEnvironment = check.fingerprint.length === 0;
  if (!sameEnvironment) lines.push(...environmentLines(manifest.fingerprint, fingerprint, check.fingerprint));
  if (check.problems.length === 0) {
    lines.push(sameEnvironment ? 'manifest intact' : 'manifest intact (in another environment)');
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }
  const plural = `${check.problems.length} difference${check.problems.length === 1 ? '' : 's'}`;
  lines.push(sameEnvironment ? `INTEGRITY BROKEN: ${plural} from the manifest` : `${plural} from the manifest:`);
  lines.push(...problemLines(check.problems, manifest));
  if (sameEnvironment) {
    lines.push('Same environment as when the corpus was frozen, so the stored cases or observations were changed. If the change is intended, run port-anything baseline again and commit the new manifest.');
    return { exitCode: INTEGRITY_BROKEN, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }
  return {
    exitCode: 0,
    stdout: `${lines.join('\n')}\n`,
    stderr: `port-anything verify: warning: ${plural} from the manifest, but the environment differs (${check.fingerprint.join(', ')}); ${
      manifest.fingerprint.mode === 'container' && fingerprint.mode === 'container'
        ? 'run where the manifest was frozen (the same image digest and architecture; pin sandbox.image by digest), or re-baseline.'
        : 're-baseline or use container mode.'
    }\n`,
  };
}

function environmentLines(frozen: Fingerprint, now: Fingerprint, fields: readonly FingerprintField[]): string[] {
  const show = (fp: Fingerprint, field: FingerprintField) => fingerprintField(fp, field) ?? 'none';
  return [
    'environment differs from the one the corpus was frozen in, so this check is not authoritative here:',
    ...fields.map((field) => `  ${field}: ${show(frozen, field)} then, ${show(now, field)} now`),
  ];
}

const MAX_LISTED = 20;

function problemLines(problems: readonly ManifestProblem[], manifest: Manifest): string[] {
  const generator = (g: Manifest['generator']) =>
    g === null ? 'none' : `${g.version}, seed ${g.seed}, budget ${g.budget}, error path cap ${g.error_path_cap}, min cases per feature ${g.min_cases_per_feature}`;
  const features = (list: readonly string[]) => (list.length === 0 ? 'none' : list.join(', '));
  const line = (p: ManifestProblem): string => {
    switch (p.kind) {
      case 'generator':
        return `  generated corpus settings: ${generator(p.frozen)} frozen, ${generator(p.now)} now`;
      case 'normalizers':
        return `  normalizers: port-anything.yaml no longer has the ${manifest.normalizers.length} frozen with the corpus`;
      case 'missing-case':
        return `  ${shortCaseId(p.case)}: in the manifest, no longer in the corpus`;
      case 'added-case':
        return `  ${shortCaseId(p.case)}: in the corpus, not in the manifest`;
      case 'features':
        return `  ${shortCaseId(p.case)}: features ${features(p.frozen)} frozen, ${features(p.now)} now`;
      case 'observation':
        return `  ${shortCaseId(p.case)}: the reference's observation no longer matches the frozen one`;
    }
  };
  const shown = problems.slice(0, MAX_LISTED).map(line);
  if (problems.length > MAX_LISTED) shown.push(`  and ${problems.length - MAX_LISTED} more`);
  return shown;
}

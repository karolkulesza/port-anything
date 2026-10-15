import { randomBytes } from 'node:crypto';
import { access, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  CLI_SPEC_FILE,
  ConfigError,
  SandboxUnavailableError,
  cacheDir,
  chooseSandbox,
  cliSpecYaml,
  inferCliSpec,
  parseProgramCommand,
  probeSandbox,
  readConfigFile,
  resolveProgram,
  specFeatures,
  type SandboxProbe,
  type SpecProbeResult,
} from '@port-anything/core';
import type { CliResult } from './run-command.js';

export const USAGE = 'Usage: port-anything spec infer [--no-sandbox]';

/**
 * `port-anything spec infer`: reads the reference's `--help` (and its subcommands'), writes a first
 * `port-anything/cli-spec.yaml` and validates it with the probe set. Exit code 0 when every probe
 * passes, 1 when one fails (the spec is written anyway, for review), 3 when nothing could be
 * inferred or the spec file already exists, since it may hold refinements.
 */
export async function specCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  try {
    return await infer(argv, options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything spec: ${message}\n` });

async function infer(argv: readonly string[], { cwd, probe }: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h') return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (sub !== 'infer') throw new ConfigError(sub === undefined ? `which spec command?\n${USAGE}` : `unknown spec command "${sub}".\n${USAGE}`);
  let noSandbox: boolean;
  try {
    const { values } = parseArgs({ args: [...rest], options: { 'no-sandbox': { type: 'boolean' } }, strict: true, allowPositionals: false });
    noSandbox = values['no-sandbox'] ?? false;
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }

  const config = await readConfigFile(cwd);
  if (config.sandbox.mode === 'container') throw new ConfigError('sandbox mode "container" is not available yet; set sandbox.mode to local.');
  const target = join(cwd, CLI_SPEC_FILE);
  if (await exists(target)) throw new ConfigError(`${CLI_SPEC_FILE} already exists and may hold refinements; delete it to infer a new one.`);
  let reference;
  try {
    reference = await resolveProgram(parseProgramCommand(config.reference.cmd), { cwd });
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const sandbox = chooseSandbox(probe ?? (await probeSandbox()), { noSandbox });

  const workDir = join(cwd, '.port-anything', 'tmp', `spec-${randomBytes(6).toString('hex')}`);
  let result;
  try {
    result = await inferCliSpec({
      reference,
      store: new BlobStore(cacheDir(cwd)),
      sandbox,
      workDir,
      ...(config.program_name === undefined ? {} : { programName: config.program_name }),
      timeoutMs: config.sandbox.timeout,
      envAllowlist: config.sandbox.env_allowlist,
      env: config.sandbox.env,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rmdir(join(cwd, '.port-anything', 'tmp')).catch(() => {}); // kept while another command uses it
  }
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, cliSpecYaml(result.spec), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigError(`${CLI_SPEC_FILE} appeared while inferring; it was left as it is.`);
    throw e;
  }

  const { spec, probes } = result;
  const features = specFeatures(spec);
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `Wrote ${CLI_SPEC_FILE} from "${spec.program} ${result.helpArgv.join(' ')}", sandbox: ${sandbox.label}`,
    `  ${count(spec.flags.length, 'flag')}, ${count(spec.forms.length, 'form')}, ${count(spec.subcommands.length, 'subcommand')}; ${count(features.length, 'feature')} (${features.filter((f) => f.selfDescription).length} self-description)`,
    probeSummary(probes),
  ];
  for (const p of probes.filter((r) => r.status !== 'pass')) lines.push(`  ${p.status}  ${p.argv.join(' ')}: ${p.detail}`);
  return { exitCode: probes.some((p) => p.status === 'fail') ? 1 : 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function probeSummary(probes: readonly SpecProbeResult[]): string {
  const n = (status: SpecProbeResult['status']) => probes.filter((p) => p.status === status).length;
  const extra = [n('fail') > 0 ? `${n('fail')} fail` : '', n('inconclusive') > 0 ? `${n('inconclusive')} inconclusive` : ''].filter((s) => s !== '');
  return `Probes: ${n('pass')} of ${probes.length} pass${extra.length > 0 ? `, ${extra.join(', ')}` : ''}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

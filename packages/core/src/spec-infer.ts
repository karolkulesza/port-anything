import type { CliSpec } from './cli-spec.js';
import { ConfigError } from './config.js';
import { cliSpecFromHelp, parseHelp, type ParsedHelp } from './help-parser.js';
import { canonicalCase, type Observation } from './model.js';
import { runCases, type RunCasesOptions } from './run-cases.js';
import { judgeProbes, specProbes, type ProbeOutcome, type SpecProbeResult } from './spec-probe.js';

export interface InferCliSpecOptions extends Omit<RunCasesOptions, 'candidates' | 'cases' | 'onCase'> {
  /** Subcommands whose own `--help` is read and probed; the rest keep only their name. Default 20. */
  maxSubcommands?: number;
}

export interface InferCliSpecResult {
  spec: CliSpec;
  /** The invocation whose output the spec was read from (`--help` or `-h`). */
  helpArgv: string[];
  probes: SpecProbeResult[];
}

/**
 * Infers a first CLI spec for the reference: runs it with `--help` (or `-h` when that prints
 * nothing usable), parses the text, does the same for each listed subcommand, then validates the
 * result with the probe set. Every run goes through the case runner, so the sandbox, environment
 * and argv[0] are the same as for real cases. Throws a `ConfigError` when no help text is found.
 */
export async function inferCliSpec(options: InferCliSpecOptions): Promise<InferCliSpecResult> {
  const run = async (argvs: string[][]) => {
    const cases = argvs.map((argv) => canonicalCase({ argv, origin: 'generated' }));
    const result = await runCases({ ...options, candidates: [], cases });
    const byId = new Map(result.cases.map((c) => [c.caseId, c.reference]));
    return { programName: result.programName, observations: cases.map((c) => byId.get(c.id)!) };
  };
  const text = async (o: Observation) => {
    const stdout = (await options.store.get(o.stdout)).toString('utf8');
    return stdout.trim() !== '' ? stdout : (await options.store.get(o.stderr)).toString('utf8');
  };

  const HELP_ARGVS = [['--help'], ['-h']];
  const first = await run(HELP_ARGVS);
  const program = first.programName;
  let help: ParsedHelp | undefined;
  let helpArgv: string[] = [];
  for (const [i, o] of first.observations.entries()) {
    const parsed = parseHelp(await text(o), { program });
    if (o.timeout || !useful(parsed)) continue;
    (help = parsed), (helpArgv = HELP_ARGVS[i]!);
    break;
  }
  if (!help) throw new ConfigError(`The reference printed no help text that could be read, with --help or -h.`);

  const subcommands = help.subcommands.slice(0, options.maxSubcommands ?? 20).map((s) => s.name);
  const subHelp: Record<string, ParsedHelp> = {};
  if (subcommands.length > 0) {
    const { observations } = await run(subcommands.map((name) => [name, '--help']));
    for (const [i, o] of observations.entries()) {
      const parsed = parseHelp(await text(o), { program });
      if (!o.timeout && useful(parsed)) subHelp[subcommands[i]!] = parsed;
    }
  }
  const spec = cliSpecFromHelp(program, help, subHelp);

  const probes = specProbes(spec, { maxSubcommands: options.maxSubcommands ?? 20 });
  const { observations } = await run(probes.map((p) => p.argv));
  const outcomes: ProbeOutcome[] = [];
  for (const o of observations) {
    outcomes.push({ exit: o.exit, signal: o.signal, timeout: o.timeout, stderr: (await options.store.get(o.stderr)).toString('utf8') });
  }
  return { spec, helpArgv, probes: judgeProbes(probes, outcomes) };
}

const useful = (help: ParsedHelp): boolean => help.flags.length > 0 || help.forms.length > 0 || help.subcommands.length > 0;


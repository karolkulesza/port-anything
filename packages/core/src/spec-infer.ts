import { CLI_SPEC_DOCS, CLI_SPEC_FILE, type CliSpec } from './cli-spec.js';
import { ConfigError } from './config.js';
import { destructiveCommand } from './destructive.js';
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
  /** The invocation whose output the spec was read from (`--help`, `-h`, or no arguments: empty). */
  helpArgv: string[];
  probes: SpecProbeResult[];
}

/**
 * Infers a first CLI spec for the reference: runs it with `--help` (or `-h`, or no arguments, when
 * that prints nothing usable: many programs without a help option, such as awk and BSD tools,
 * print a usage line when called with nothing), parses the text, does the same for each listed
 * subcommand, then validates the result with the probe set. Every run goes through the case
 * runner, so the sandbox, environment and argv[0] are the same as for real cases. Throws a
 * `ConfigError` saying what to do instead when no help text is found.
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

  let program = '';
  let help: ParsedHelp | undefined;
  let helpArgv: string[] = [];
  const readHelp = async (argvs: string[][]) => {
    const result = await run(argvs);
    program = result.programName;
    for (const [i, o] of result.observations.entries()) {
      const parsed = parseHelp(await text(o), { program });
      if (o.timeout || !useful(parsed)) continue;
      (help = parsed), (helpArgv = argvs[i]!);
      return;
    }
  };
  await readHelp([['--help'], ['-h']]);
  // Called with nothing, a program may do what it is for (a denylisted one too: `shutdown`), so
  // only when the help options gave nothing, and never for a tool known to be destructive.
  const { reference } = options;
  const destructive = [[program], [reference.path, ...(reference.tool === undefined ? [] : [reference.tool]), ...reference.args]].some((argv) => destructiveCommand(argv) !== null);
  if (!help && !destructive) await readHelp([[]]);
  if (!help) throw new ConfigError(NO_HELP_MESSAGE);

  const subcommands = help.subcommands.slice(0, options.maxSubcommands ?? 20).map((s) => s.name);
  const subHelp: Record<string, ParsedHelp> = {};
  if (subcommands.length > 0) {
    const { observations } = await run(subcommands.map((name) => [name, '--help']));
    for (const [i, o] of observations.entries()) {
      const parsed = parseHelp(await text(o), { program });
      if (!o.timeout && useful(parsed)) subHelp[subcommands[i]!] = parsed;
    }
  }
  let spec: CliSpec;
  try {
    spec = cliSpecFromHelp(program, help, subHelp, helpArgv[0]);
  } catch (e) {
    // The parser keeps its output valid; this is a safety net, not an expected path.
    throw new ConfigError(`The reference's help text gave a spec that isn't valid: ${(e as Error).message}`);
  }

  // Spellings the help doesn't list (`-p` for `-ps`) stay in the spec only if the program takes them.
  const guessed = new Map(help.flags.flatMap((f) => (f.aliasCandidates ?? []).map((n) => [n, f.names[0]!] as const)));
  const probes = specProbes(spec, { maxSubcommands: options.maxSubcommands ?? 20, guessed });
  const { observations } = await run(probes.map((p) => p.argv));
  const outcomes: ProbeOutcome[] = [];
  for (const o of observations) {
    outcomes.push({ exit: o.exit, signal: o.signal, timeout: o.timeout, stderr: (await options.store.get(o.stderr)).toString('utf8') });
  }
  const dropped = new Set<string>();
  const judged = judgeProbes(probes, outcomes).map((p): SpecProbeResult => {
    if (p.aliasOf === undefined) return p;
    if (p.status === 'pass') return { ...p, detail: `${p.detail}: kept as a spelling of ${p.aliasOf}` };
    dropped.add(p.flag);
    const why = p.detail.endsWith('after all') ? p.detail : `${p.detail}: not checked as a spelling of ${p.aliasOf}`;
    return { ...p, status: 'pass', detail: `${why}, so it was left out of the spec` };
  });
  if (dropped.size > 0) spec = { ...spec, flags: spec.flags.map((f) => ({ ...f, names: f.names.filter((n) => !dropped.has(n)) })) };
  return { spec, helpArgv, probes: judged };
}

/** Why no spec could be inferred, and the two ways on. */
export const NO_HELP_MESSAGE = [
  'The reference printed no help text that could be read, with --help, -h or no arguments.',
  `Write ${CLI_SPEC_FILE} yourself (the format: ${CLI_SPEC_DOCS}), or record cases in port-anything/recorded/*.jsonl and run them with port-anything run.`,
].join('\n');

const useful = (help: ParsedHelp): boolean => help.flags.length > 0 || help.forms.length > 0 || help.subcommands.length > 0;


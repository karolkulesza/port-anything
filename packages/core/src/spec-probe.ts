import type { CliSpec, CliValue } from './cli-spec.js';

/** A flag no program has: every program must reject it. */
export const UNKNOWN_LONG_FLAG = '--port-anything-no-such-flag';

// Letters tried, rarest first, for a one-letter flag the spec doesn't list.
const SHORT_CANDIDATES = 'QZJYKGWXBEHIOPURTVLMNSDFACqzjykgwxbehiopurtvlmnsdfac';

/**
 * One invocation that checks the spec against the program:
 * - `unknown-long`, `unknown-short`: a flag the spec doesn't list must be an error;
 * - `missing-value`: a flag that needs a value, given none, must be an error;
 * - `known-flag`: a flag the spec lists must not get the answer an unknown flag gets.
 */
export interface SpecProbe {
  kind: 'unknown-long' | 'unknown-short' | 'missing-value' | 'known-flag';
  argv: string[];
  /** The flag spelling under test. */
  flag: string;
  /** The subcommand the probe runs under, if any. */
  subcommand?: string;
  /** `known-flag`: a spelling the help doesn't list, guessed for this listed one (`-p` for `-ps`). */
  aliasOf?: string;
  /** `known-flag`: the flag is marked self-description, so it may answer like an unknown flag. */
  selfDescription?: true;
  /** `known-flag`: by its name or description, the flag likely prints the help. */
  helpLike?: true;
  /** `unknown-long`: the listed flag a program that reads `--x` as `-x` would take it for. */
  readAs?: string;
}

/** What a probe saw. `inconclusive`: it timed out, or there was nothing to compare against. */
export interface SpecProbeResult extends SpecProbe {
  status: 'pass' | 'fail' | 'inconclusive';
  detail: string;
}

/** How a probe's run ended, as far as judging it goes. */
export interface ProbeOutcome {
  exit: number | null;
  signal: string | null;
  timeout: boolean;
  stderr: string;
}

/**
 * The probes for a spec: the top-level command's flags, plus an unknown flag under each subcommand.
 * `guessed` maps spellings the help doesn't list to the listed spelling they were guessed for.
 */
export function specProbes(spec: CliSpec, options: { maxSubcommands?: number; guessed?: ReadonlyMap<string, string> } = {}): SpecProbe[] {
  const names = new Set(spec.flags.flatMap((f) => f.names));
  // xxd reads `--port-anything-no-such-flag` as `-p…`, which it matches by its first letter. Only
  // a single-dash name longer than a letter (`-ps`) hints at that; a plain `-p` (mkdir) doesn't.
  const single = `-${UNKNOWN_LONG_FLAG.slice(2)}`;
  const sameLetter = [...names].filter((n) => !n.startsWith('--') && n.slice(0, 2) === single.slice(0, 2)).sort((a, b) => a.length - b.length);
  const readAs = sameLetter.some((n) => n.length > 2) ? sameLetter[0] : undefined;
  const probes: SpecProbe[] = [{ kind: 'unknown-long', argv: [UNKNOWN_LONG_FLAG], flag: UNKNOWN_LONG_FLAG, ...(readAs === undefined ? {} : { readAs }) }];
  const letter = [...SHORT_CANDIDATES].find((c) => !names.has(`-${c}`));
  if (letter !== undefined) probes.push({ kind: 'unknown-short', argv: [`-${letter}`], flag: `-${letter}` });
  for (const flag of spec.flags) {
    if (flag.arity > 0 && !flag.values[0]!.optional) probes.push({ kind: 'missing-value', argv: [flag.names[0]!], flag: flag.names[0]! });
    const helpLike = flag.names.some((n) => /^-{1,2}(h|help|\?)$/.test(n)) || /\b(help|usage|summary)\b/i.test(flag.description ?? '');
    for (const name of flag.names) {
      const aliasOf = options.guessed?.get(name);
      probes.push({
        kind: 'known-flag',
        argv: [name, ...flag.values.filter((v) => !v.optional).map(sampleValue)],
        flag: name,
        ...(aliasOf === undefined ? {} : { aliasOf }),
        ...(flag.self_description === true ? { selfDescription: true as const } : helpLike ? { helpLike: true as const } : {}),
      });
    }
  }
  for (const sub of spec.subcommands.slice(0, options.maxSubcommands ?? 20)) {
    probes.push({ kind: 'unknown-long', argv: [sub.name, UNKNOWN_LONG_FLAG], flag: UNKNOWN_LONG_FLAG, subcommand: sub.name });
  }
  return probes;
}

/** A plain value of the right type for a flag that must be given one. Paths stay relative. */
function sampleValue(value: CliValue): string {
  switch (value.type) {
    case 'enum':
      return value.choices![0]!;
    case 'int':
    case 'size':
      return '1';
    case 'path':
      return 'probe.txt';
    default:
      return 'x';
  }
}

/** Judges each probe from how its run ended; `outcomes` is in the order of `probes`. */
export function judgeProbes(probes: readonly SpecProbe[], outcomes: readonly ProbeOutcome[]): SpecProbeResult[] {
  const unknownOf = (subcommand: string | undefined, short: boolean): ProbeOutcome | undefined => {
    const i = probes.findIndex((p) => p.subcommand === subcommand && p.kind === (short ? 'unknown-short' : 'unknown-long'));
    return i < 0 ? undefined : outcomes[i];
  };
  return probes.map((probe, i) => {
    const outcome = outcomes[i]!;
    const judged = (status: SpecProbeResult['status'], detail: string): SpecProbeResult => ({ ...probe, status, detail });
    if (outcome.timeout) return judged('inconclusive', 'timed out');
    if (outcome.signal !== null) return judged('fail', `killed by ${outcome.signal}`);
    if (probe.kind !== 'known-flag') {
      if (outcome.exit !== 0) return judged('pass', `exit ${outcome.exit}`);
      if (probe.readAs !== undefined) {
        return judged('inconclusive', `exit 0: the program accepts ${probe.flag}, likely as ${probe.readAs} (it reads --x as -x), so no unknown long flag can be probed`);
      }
      const what = probe.kind === 'missing-value' ? `${probe.flag} without its value` : `the unknown flag ${probe.flag}`;
      return judged('fail', `exit 0: the program accepts ${what}`);
    }
    // `-ps`, `-name`: a single-dash spelling is answered like an unknown single-dash one.
    const short = /^-[^-]/.test(probe.flag);
    const unknown = unknownOf(undefined, short);
    if (!unknown || unknown.exit === 0 || unknown.timeout || unknown.signal !== null) return judged('inconclusive', 'no unknown-flag answer to compare with');
    const unknownFlag = probes.find((p) => p.subcommand === undefined && p.kind === (short ? 'unknown-short' : 'unknown-long'))!.flag;
    const mine = firstLine(outcome.stderr, probe.flag);
    if (outcome.exit === unknown.exit && mine !== '' && mine === firstLine(unknown.stderr, unknownFlag)) {
      // The likely cause, so the spec can be fixed: a guess that was wrong, the help printed as a
      // usage error, a value the spec doesn't give the flag.
      const said = (outcome.stderr.split('\n').find((l) => l.trim() !== '') ?? '').trim();
      if (probe.selfDescription) return judged('pass', `answered like an unknown flag (${said}), as a self-description flag may`);
      if (probe.aliasOf !== undefined) return judged('fail', `rejected like an unknown flag (${said}): not a spelling of ${probe.aliasOf} after all`);
      if (probe.helpLike) return judged('fail', `listed in the help but answered like an unknown flag (${said}): if it prints the help, mark it self_description: true`);
      if (probe.argv.length === 1) return judged('fail', `rejected like an unknown flag (${said}): does it take a value? The spec gives it none, or the program doesn't have it`);
      return judged('fail', `rejected like an unknown flag: ${said}`);
    }
    return judged('pass', `exit ${outcome.exit}`);
  });
}

/** The first non-empty line of stderr with the flag written as `<FLAG>` (`-Q`, `'Q'`, `--x`). */
function firstLine(stderr: string, flag: string): string {
  const line = stderr.split('\n').find((l) => l.trim() !== '') ?? '';
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = line.replace(new RegExp(escaped, 'g'), '<FLAG>');
  if (/^-[^-]$/.test(flag)) out = out.replace(new RegExp(`(['"\`‘])${escaped.slice(1)}(['"’])`, 'g'), '$1<FLAG>$2');
  return out.trim();
}

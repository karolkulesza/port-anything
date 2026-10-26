import { describe, expect, it } from 'vitest';
import { parseCliSpec } from '../src/cli-spec.js';
import { UNKNOWN_LONG_FLAG, judgeProbes, specProbes, type ProbeOutcome, type SpecProbe } from '../src/spec-probe.js';

const spec = parseCliSpec({
  version: 1,
  program: 'frob',
  flags: [
    { names: ['-Q', '--quiet'], feature: 'opt.quiet', arity: 0 },
    { names: ['-n'], feature: 'opt.n', arity: 1, values: [{ name: 'N', type: 'int' }] },
    { names: ['--color'], feature: 'opt.color', arity: 1, values: [{ name: 'WHEN', type: 'enum', choices: ['auto', 'never'], optional: true }] },
    { names: ['--mode'], feature: 'opt.mode', arity: 1, values: [{ name: 'M', type: 'enum', choices: ['fast', 'slow'] }] },
    { names: ['--arg'], feature: 'opt.arg', arity: 2, values: [{ name: 'A', type: 'string' }, { name: 'F', type: 'path' }] },
  ],
  subcommands: [{ name: 'make', feature: 'cmd.make' }],
});

describe('specProbes', () => {
  it('probes unknown flags, missing values, every listed spelling and each subcommand', () => {
    expect(specProbes(spec).map((p) => [p.kind, p.argv.join(' '), p.subcommand ?? ''])).toEqual([
      ['unknown-long', UNKNOWN_LONG_FLAG, ''],
      ['unknown-short', '-Z', ''], // -Q is taken
      ['known-flag', '-Q', ''],
      ['known-flag', '--quiet', ''],
      ['missing-value', '-n', ''],
      ['known-flag', '-n 1', ''],
      ['known-flag', '--color', ''],
      ['missing-value', '--mode', ''],
      ['known-flag', '--mode fast', ''],
      ['missing-value', '--arg', ''],
      ['known-flag', '--arg x probe.txt', ''],
      ['unknown-long', `make ${UNKNOWN_LONG_FLAG}`, 'make'],
    ]);
  });

  it('marks guessed spellings, self-description and help-like flags, and what an unknown long flag may be read as', () => {
    const xxd = parseCliSpec({
      version: 1,
      program: 'frob',
      flags: [
        { names: ['-ps', '-p'], feature: 'opt.ps', arity: 0 },
        { names: ['-h'], feature: 'opt.h', arity: 0, description: 'print this summary' },
        { names: ['-v'], feature: 'opt.v', arity: 0, self_description: true },
        { names: ['-s'], feature: 'opt.s', arity: 0 },
      ],
    });
    const probes = specProbes(xxd, { guessed: new Map([['-p', '-ps']]) });
    expect(probes.find((p) => p.kind === 'unknown-long')!.readAs).toBe('-p');
    expect(probes.filter((p) => p.kind === 'known-flag').map((p) => [p.flag, p.aliasOf ?? '', p.selfDescription ?? false, p.helpLike ?? false])).toEqual([
      ['-ps', '', false, false],
      ['-p', '-ps', false, false],
      ['-h', '', false, true],
      ['-v', '', true, false],
      ['-s', '', false, false],
    ]);
    expect(specProbes(spec).find((p) => p.kind === 'unknown-long')!.readAs).toBeUndefined();
  });

  it('caps the subcommands probed', () => {
    expect(specProbes(spec, { maxSubcommands: 0 }).some((p) => p.subcommand !== undefined)).toBe(false);
  });
});

describe('judgeProbes', () => {
  const out = (exit: number | null, stderr = '', more: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ exit, signal: null, timeout: false, stderr, ...more });
  const probes: SpecProbe[] = [
    { kind: 'unknown-long', argv: [UNKNOWN_LONG_FLAG], flag: UNKNOWN_LONG_FLAG },
    { kind: 'unknown-short', argv: ['-Z'], flag: '-Z' },
    { kind: 'known-flag', argv: ['--quiet'], flag: '--quiet' },
    { kind: 'known-flag', argv: ['--ghost'], flag: '--ghost' },
    { kind: 'known-flag', argv: ['-g'], flag: '-g' },
    { kind: 'missing-value', argv: ['-n'], flag: '-n' },
  ];

  it('passes errors for unknown flags and missing values, fails flags rejected like unknown ones', () => {
    const results = judgeProbes(probes, [
      out(2, `frob: unrecognized option '${UNKNOWN_LONG_FLAG}'\nTry 'frob --help'.\n`),
      out(2, "frob: invalid option -- 'Z'\n"),
      out(0),
      out(2, "frob: unrecognized option '--ghost'\nTry 'frob --help'.\n"),
      out(2, "frob: invalid option -- 'g'\n"),
      out(2, "frob: option requires an argument -- 'n'\n"),
    ]);
    expect(results.map((r) => [r.flag, r.status])).toEqual([
      [UNKNOWN_LONG_FLAG, 'pass'],
      ['-Z', 'pass'],
      ['--quiet', 'pass'],
      ['--ghost', 'fail'],
      ['-g', 'fail'],
      ['-n', 'pass'],
    ]);
    expect(results[3]!.detail).toBe("rejected like an unknown flag (frob: unrecognized option '--ghost'): does it take a value? The spec gives it none, or the program doesn't have it");
  });

  it('names the likely cause when a listed flag is answered like an unknown one', () => {
    // xxd answers an unknown flag, and a flag missing its value, with its whole help text.
    const usage = 'Usage:';
    const known = (flag: string, more: Partial<SpecProbe> = {}, argv = [flag]): SpecProbe => ({ kind: 'known-flag', argv, flag, ...more });
    const cases: SpecProbe[] = [
      { kind: 'unknown-long', argv: [UNKNOWN_LONG_FLAG], flag: UNKNOWN_LONG_FLAG },
      { kind: 'unknown-short', argv: ['-Q'], flag: '-Q' },
      known('-s'),
      known('-h', { helpLike: true }),
      known('-v', { selfDescription: true }),
      known('-p', { aliasOf: '-ps' }),
      known('-n', {}, ['-n', '1']),
    ];
    const results = judgeProbes(cases, cases.map(() => out(1, `${usage}\n       frob [-a] [-s [-]offset] [file]\n`)));
    expect(results.slice(2).map((r) => [r.flag, r.status, r.detail])).toEqual([
      ['-s', 'fail', `rejected like an unknown flag (${usage}): does it take a value? The spec gives it none, or the program doesn't have it`],
      ['-h', 'fail', `listed in the help but answered like an unknown flag (${usage}): if it prints the help, mark it self_description: true`],
      ['-v', 'pass', `answered like an unknown flag (${usage}), as a self-description flag may`],
      ['-p', 'fail', `rejected like an unknown flag (${usage}): not a spelling of -ps after all`],
      ['-n', 'fail', `rejected like an unknown flag: ${usage}`],
    ]);
  });

  it('calls an accepted unknown long flag inconclusive when the program likely reads --x as -x', () => {
    const lax: SpecProbe[] = [{ kind: 'unknown-long', argv: [UNKNOWN_LONG_FLAG], flag: UNKNOWN_LONG_FLAG, readAs: '-ps' }];
    expect(judgeProbes(lax, [out(0)])).toMatchObject([
      { status: 'inconclusive', detail: `exit 0: the program accepts ${UNKNOWN_LONG_FLAG}, likely as -ps (it reads --x as -x), so no unknown long flag can be probed` },
    ]);
  });

  it('fails a program that accepts unknown flags or a missing value, and then cannot judge listed flags', () => {
    const results = judgeProbes(probes, [out(0), out(0), out(0), out(0), out(0), out(0)]);
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail', 'inconclusive', 'inconclusive', 'inconclusive', 'fail']);
    expect(results[0]!.detail).toBe(`exit 0: the program accepts the unknown flag ${UNKNOWN_LONG_FLAG}`);
    expect(results[5]!.detail).toBe('exit 0: the program accepts -n without its value');
  });

  it('counts a timeout as inconclusive and a crash as a failure', () => {
    const results = judgeProbes(probes.slice(0, 2), [out(null, '', { timeout: true, signal: 'SIGKILL' }), out(null, '', { signal: 'SIGSEGV' })]);
    expect(results.map((r) => [r.status, r.detail])).toEqual([
      ['inconclusive', 'timed out'],
      ['fail', 'killed by SIGSEGV'],
    ]);
  });
});

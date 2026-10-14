import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateArgvCases, isSafeArgvToken, type GeneratedArgv } from '../src/argv-generator.js';
import { blobRef } from '../src/blob-store.js';
import { parseCliSpec, type CliSpec } from '../src/cli-spec.js';
import { DestructiveToolError } from '../src/destructive.js';
import { canonicalCase } from '../src/model.js';
import { createRng, type GeneratorVersion } from '../src/rng.js';
import { UNKNOWN_LONG_FLAG } from '../src/spec-probe.js';

const frob: CliSpec = parseCliSpec({
  version: 1,
  program: 'frob',
  flags: [
    { names: ['-n', '--numeric'], feature: 'opt.numeric', arity: 0 },
    { names: ['-r', '--reverse'], feature: 'opt.reverse', arity: 0 },
    { names: ['-u'], feature: 'opt.u', arity: 0 },
    { names: ['-k', '--key'], feature: 'opt.key', arity: 1, values: [{ name: 'N', type: 'int' }] },
    { names: ['-S', '--buffer-size'], feature: 'opt.buffer-size', arity: 1, values: [{ name: 'SIZE', type: 'size' }] },
    { names: ['-o', '--output'], feature: 'opt.output', arity: 1, values: [{ name: 'FILE', type: 'path' }] },
    { names: ['-t'], feature: 'opt.t', arity: 1, values: [{ name: 'SEP', type: 'string' }] },
    {
      names: ['--sort'],
      feature: 'opt.sort',
      arity: 1,
      // Choices that look like paths outside the sandbox must never be emitted.
      values: [{ name: 'WORD', type: 'enum', choices: ['numeric', 'month', '/etc/passwd', '../up', '~root'] }],
    },
    { names: ['--color'], feature: 'opt.color', arity: 1, values: [{ name: 'WHEN', type: 'enum', choices: ['auto', 'never'], optional: true }] },
    { names: ['--pair'], feature: 'opt.pair', arity: 2, values: [{ name: 'A', type: 'string' }, { name: 'B', type: 'path' }] },
    { names: ['--help'], feature: 'opt.help', arity: 0, self_description: true },
  ],
  forms: [{ usage: 'frob [OPTION]... [FILE]...', args: [{ name: 'FILE', type: 'path', arity: '*' }] }],
});

const gitLike: CliSpec = parseCliSpec({
  version: 1,
  program: 'git',
  flags: [{ names: ['--no-pager'], feature: 'opt.no-pager', arity: 0 }],
  subcommands: [
    { name: 'log', feature: 'cmd.log', flags: [{ names: ['--oneline'], feature: 'cmd.log.opt.oneline', arity: 0 }] },
    { name: 'push', feature: 'cmd.push', flags: [{ names: ['--force'], feature: 'cmd.push.opt.force', arity: 0 }] },
    { name: '/bin/sh', feature: 'cmd.sh' },
    { name: '..', feature: 'cmd.up' },
  ],
});

const gen = (spec: CliSpec, seed: string | number = 42, generator: GeneratorVersion = 'v1', iKnow?: boolean): GeneratedArgv =>
  generateArgvCases(spec, { seed, generator, ...(iKnow === undefined ? {} : { iKnow }) });

const ids = (out: GeneratedArgv) => out.cases.map((c) => c.case.id);
const argvs = (out: GeneratedArgv) => out.cases.map((c) => c.case.argv);

// Stricter than the generator's own check: a `/` or `~` right after the start, any `=` or an
// attached short flag (`-o/x`), or a `..` anywhere between separators, counts as an escape.
function escapes(token: string): boolean {
  if (/(^|=)[/~]/.test(token) || /^-[^-][/~]/.test(token)) return true;
  return /(^|[/\\=])\.\.([/\\=]|$)/.test(token) || /^-[^-]\.\.([/\\=]|$)/.test(token);
}

/** Random specs with hostile names and choices, to look for an escape the fixed specs miss. */
function randomSpec(seed: number): CliSpec {
  const rng = createRng(seed, 'v1');
  const words = ['a', 'b c', '/abs', '../x', 'x/../y', '~', '~user/f', '..', 'ok/sub', 'C:\\x', '-', 'é', 'k=/abs', 'of=../x', 'a=~/x', 'a=b/..', 'k=v'];
  const types = ['string', 'int', 'size', 'path', 'enum'] as const;
  const flags = Array.from({ length: 1 + rng.int(8) }, (_, i) => {
    const arity = rng.int(3);
    const values = Array.from({ length: arity }, (_, j) => {
      const type = rng.pick(types);
      return type === 'enum' ? { name: `V${j}`, type, choices: [rng.pick(words), rng.pick(words)] } : { name: `V${j}`, type };
    });
    return { names: [`--f${i}`, ...(rng.int(2) ? [`-${'abcdefgh'[i]}`] : [])], feature: `opt.f${i}`, arity, values };
  });
  const args = Array.from({ length: rng.int(3) }, (_, i) => ({ name: `P${i}`, type: rng.pick(types.slice(0, 4)), arity: rng.pick(['1', '?', '*', '+'] as const) }));
  return parseCliSpec({ version: 1, program: 'rand', flags, forms: [{ usage: 'rand', args }] });
}

describe('generateArgvCases: paths stay inside the sandbox', () => {
  it('never emits an absolute path or a .. escape, in argv or fixtures', () => {
    const specs = [frob, gitLike, ...Array.from({ length: 30 }, (_, i) => randomSpec(i))];
    let tokens = 0;
    for (const spec of specs) {
      for (const seed of [1, 2]) {
        for (const { case: c } of gen(spec, seed, 'v1', true).cases) {
          for (const token of c.argv) {
            tokens++;
            expect(escapes(token), `${spec.program}: ${JSON.stringify(c.argv)}`).toBe(false);
          }
          for (const path of Object.keys(c.fixtures)) expect(escapes(path), path).toBe(false);
        }
      }
    }
    expect(tokens).toBeGreaterThan(5000);
    // About a second alone; give a loaded machine room.
  }, 60_000);

  it('leaves out choices and subcommand names that would escape', () => {
    const all = [...argvs(gen(frob)), ...argvs(gen(gitLike))].flat().join('\n');
    expect(all).not.toMatch(/passwd|\.\.\/up|~root|\/bin\/sh/);
    expect(argvs(gen(gitLike)).some((a) => a[0] === '..')).toBe(false);
  });

  it('drops key=value choices that would escape, on long and short flags, without failing', () => {
    const spec = parseCliSpec({
      version: 1,
      program: 'kv',
      flags: [
        { names: ['-x'], feature: 'opt.x', arity: 1, values: [{ name: 'KV', type: 'enum', choices: ['k=/etc/passwd', 'of=../x', 'a=~/x', 'ok=fine'] }] },
        { names: ['--opt'], feature: 'opt.opt', arity: 1, values: [{ name: 'KV', type: 'enum', choices: ['k=/etc/passwd', 'of=../x', 'ok=fine'] }] },
      ],
    });
    for (const seed of [1, 2, 3, 4]) {
      const all = argvs(gen(spec, seed)).flat();
      for (const token of all) expect(escapes(token), token).toBe(false);
      expect(all.join('\n')).not.toMatch(/passwd|\.\.\/x|~\/x/);
      expect(all.some((t) => t.includes('ok=fine'))).toBe(true);
    }
  });

  it('isSafeArgvToken accepts relative paths and rejects escapes', () => {
    for (const ok of ['input.txt', 'dir with spaces/file name.txt', '--output=a/b', '-', '', 'a..b', '--x=a=b', '...', '-1', '-xa', '--of=k=v']) expect(isSafeArgvToken(ok), ok).toBe(true);
    for (const bad of ['/etc', '~', '~/x', '..', '../x', 'a/../b', 'a/..', '--output=/tmp/x', '--o=../x', '--o=~/x', 'a\\..\\b', 'k=/etc', '--opt=k=/etc', '--opt=of=../x', 'of=..', '-x/etc', '-xa=/etc', '-x..', '-x~/x']) expect(isSafeArgvToken(bad), bad).toBe(false);
  });

  it('gives every existing path value its fixture, and none to the missing one', () => {
    const cases = gen(frob).cases.map((c) => c.case);
    const withSpaces = cases.find((c) => c.argv.some((t) => t.endsWith('dir with spaces/file name.txt')));
    expect(withSpaces?.fixtures).toHaveProperty(['dir with spaces/file name.txt']);
    const dir = cases.find((c) => c.argv.some((t) => t === 'dir with spaces' || t.endsWith('=dir with spaces')));
    expect(dir?.fixtures).toHaveProperty(['dir with spaces/file name.txt']);
    const missing = cases.find((c) => c.argv.some((t) => t.endsWith('missing.txt')));
    expect(missing).toBeDefined();
    expect(Object.keys(missing!.fixtures)).not.toContain('missing.txt');
    for (const c of cases) {
      for (const token of c.argv) {
        for (const file of ['input.txt', 'data.txt', 'ünïcödé.txt', 'empty.txt']) {
          if (token === file || token.endsWith(`=${file}`)) expect(c.fixtures, `${file} in ${JSON.stringify(c.argv)}`).toHaveProperty([file]);
        }
      }
    }
    const empty = cases.find((c) => 'empty.txt' in c.fixtures)!;
    expect(empty.fixtures['empty.txt']).toBe(blobRef(''));
  });
});

describe('generateArgvCases: destructive tools', () => {
  const rm = parseCliSpec({ version: 1, program: 'rm', flags: [{ names: ['-r'], feature: 'opt.r', arity: 0 }], forms: [{ usage: 'rm FILE', args: [{ name: 'FILE', type: 'path', arity: '+' }] }] });

  it('refuses a denylisted tool without iKnow', () => {
    expect(() => gen(rm)).toThrow(DestructiveToolError);
    expect(() => gen(rm)).toThrow(/--i-know/);
    expect(() => gen({ ...rm, program: 'mkfs.ext4' })).toThrow(DestructiveToolError);
  });

  it('generates for a denylisted tool with iKnow', () => {
    expect(gen(rm, 42, 'v1', true).cases.length).toBeGreaterThan(0);
  });

  it('leaves out a denylisted subcommand without iKnow and says so', () => {
    const out = gen(gitLike);
    expect(out.skipped).toEqual(['git push']);
    expect(argvs(out).some((a) => a.includes('push'))).toBe(false);
    expect(argvs(out).some((a) => a[0] === 'log')).toBe(true);
    const all = gen(gitLike, 42, 'v1', true);
    expect(all.skipped).toEqual([]);
    expect(argvs(all).some((a) => a[0] === 'push' && a.includes('--force'))).toBe(true);
  });
});

describe('generateArgvCases: nested destructive subcommands', () => {
  const docker = parseCliSpec({
    version: 1,
    program: 'docker',
    subcommands: [
      { name: 'system', feature: 'cmd.system', subcommands: [{ name: 'prune', feature: 'cmd.system.prune' }, { name: 'df', feature: 'cmd.system.df' }] },
      { name: 'container', feature: 'cmd.container', subcommands: [{ name: 'rm', feature: 'cmd.container.rm' }, { name: 'ls', feature: 'cmd.container.ls' }] },
    ],
  });

  it('leaves them out without iKnow, keeping their harmless siblings', () => {
    const out = gen(docker);
    expect(out.skipped).toEqual(['docker system prune', 'docker container rm']);
    const all = argvs(out);
    expect(all.some((a) => a.includes('prune') || a.includes('rm'))).toBe(false);
    expect(all.some((a) => a[0] === 'system' && a[1] === 'df')).toBe(true);
    expect(all.some((a) => a[0] === 'container' && a[1] === 'ls')).toBe(true);
  });

  it('keeps a harmless subcommand that merely ends in a denylisted word', () => {
    const git = parseCliSpec({
      version: 1,
      program: 'git',
      subcommands: [
        { name: 'stash', feature: 'cmd.stash', subcommands: [{ name: 'push', feature: 'cmd.stash.push' }] },
        { name: 'remote', feature: 'cmd.remote', subcommands: [{ name: 'prune', feature: 'cmd.remote.prune' }] },
      ],
    });
    const out = gen(git);
    expect(out.skipped).toEqual([]);
    expect(argvs(out).some((a) => a[0] === 'stash' && a[1] === 'push')).toBe(true);
    expect(argvs(out).some((a) => a[0] === 'remote' && a[1] === 'prune')).toBe(true);
  });

  it('leaves out the destructive applets of a multicall binary', () => {
    for (const program of ['busybox', '/bin/toybox', 'coreutils']) {
      const multi = parseCliSpec({
        version: 1,
        program,
        subcommands: ['rm', 'shred', 'sort'].map((name) => ({ name, feature: `cmd.${name}`, flags: [{ names: ['-f'], feature: `cmd.${name}.opt.f`, arity: 0 }] })),
      });
      const out = gen(multi);
      expect(out.skipped).toEqual([`${program} rm`, `${program} shred`]);
      expect(argvs(out).some((a) => a[0] === 'rm' || a[0] === 'shred')).toBe(false);
      expect(argvs(out).some((a) => a[0] === 'sort')).toBe(true);
    }
  });

  it('generates them with iKnow', () => {
    const all = argvs(gen(docker, 42, 'v1', true));
    expect(all.some((a) => a[0] === 'system' && a[1] === 'prune')).toBe(true);
  });
});

describe('generateArgvCases: determinism', () => {
  it('gives the same case hashes for the same seed and generator version', () => {
    expect(ids(gen(frob, 7))).toEqual(ids(gen(frob, 7)));
    expect(ids(gen(frob, 7))).toEqual(ids(gen(frob, '7')));
    expect(ids(gen(gitLike, 'abc', 'v1', true))).toEqual(ids(gen(gitLike, 'abc', 'v1', true)));
  });

  it('gives different cases for a different seed', () => {
    expect(ids(gen(frob, 7))).not.toEqual(ids(gen(frob, 8)));
  });

  it('pins the v1 output, so a refactor cannot silently change committed corpora', () => {
    const out = gen(frob, 42);
    const digest = createHash('sha256').update(ids(out).join('\n')).digest('hex');
    expect({ cases: out.cases.length, digest }).toMatchInlineSnapshot(`
      {
        "cases": 74,
        "digest": "c8306c25055d416e461e7d320d68c05218755e9b76cdbe7326056c2fcc6dd09a",
      }
    `);
  });

  it('refuses a generator version this release does not ship', () => {
    expect(() => gen(frob, 1, 'v0' as GeneratorVersion)).toThrow(/Unknown generator version "v0"/);
  });
});

describe('generateArgvCases: what it generates', () => {
  const out = gen(frob);
  const cases = out.cases.map((c) => c.case);
  const has = (pred: (argv: string[]) => boolean) => cases.some((c) => pred(c.argv));

  it('makes valid canonical generated cases whose blobs it returns, without duplicates', () => {
    expect(new Set(ids(out)).size).toBe(out.cases.length);
    for (const c of cases) {
      expect(canonicalCase(c)).toEqual(c);
      expect(c.origin).toBe('generated');
      for (const ref of [c.stdin!, ...Object.values(c.fixtures)]) {
        expect(out.blobs.get(ref), ref).toBeDefined();
        expect(blobRef(out.blobs.get(ref)!)).toBe(ref);
      }
    }
  });

  it('tries boundary values: empty, 0, -1, huge, unicode, paths with spaces', () => {
    const keyValues = cases.flatMap((c) => c.argv.flatMap((t, i) => (t === '-k' || t === '--key' ? [c.argv[i + 1]] : t.startsWith('--key=') ? [t.slice(6)] : t.startsWith('-k') ? [t.slice(2)] : [])));
    for (const v of ['0', '-1', '2147483648', '18446744073709551616', '']) expect(keyValues, v).toContain(v);
    expect(has((a) => a.some((t) => t.includes('ünïcödé ✓ 日本語')))).toBe(true);
    expect(has((a) => a.some((t) => t.length >= 4096))).toBe(true);
    expect(has((a) => a.some((t) => t.endsWith('dir with spaces/file name.txt')))).toBe(true);
    for (const choice of ['numeric', 'month']) expect(has((a) => a.includes(`--sort=${choice}`) || (a.includes('--sort') && a.includes(choice)))).toBe(true);
  });

  it('writes an optional value attached, and also leaves it out', () => {
    expect(has((a) => a.includes('--color=auto'))).toBe(true);
    expect(has((a) => a.includes('--color'))).toBe(true);
    expect(has((a) => a.includes('--color') && a.includes('auto'))).toBe(false);
  });

  it('covers every pair of flags in all four on/off combinations', () => {
    const pairable = frob.flags.filter((f) => f.self_description !== true);
    const rows = out.cases.filter((c) => c.strategy === 'pairwise').map((c) => new Set(c.case.features));
    for (let i = 0; i < pairable.length; i++) {
      for (let j = i + 1; j < pairable.length; j++) {
        for (const [a, b] of [[true, true], [true, false], [false, true], [false, false]]) {
          const fi = pairable[i]!.feature, fj = pairable[j]!.feature;
          expect(rows.some((r) => r.has(fi) === a && r.has(fj) === b), `${fi}=${a} ${fj}=${b}`).toBe(true);
        }
      }
    }
  });

  it('includes invalid calls: unknown flags, missing values, values the type rules out', () => {
    const invalid = out.cases.filter((c) => c.strategy === 'invalid').map((c) => c.case);
    expect(invalid.some((c) => c.argv.includes(UNKNOWN_LONG_FLAG))).toBe(true);
    expect(invalid.some((c) => c.argv.includes('-Q'))).toBe(true);
    expect(invalid.some((c) => ['-k', '--key'].includes(c.argv.at(-1)!) && c.features.includes('opt.key'))).toBe(true);
    expect(invalid.some((c) => c.argv.some((t) => t.endsWith('abc')) && c.features.includes('opt.key'))).toBe(true);
    expect(invalid.some((c) => c.argv.some((t) => t.endsWith('port-anything-invalid')) && c.features.includes('opt.sort'))).toBe(true);
    // An optional value can't be missing.
    expect(invalid.some((c) => c.argv.at(-1) === '--color')).toBe(false);
  });

  it('tags cases with their flags features, no-flag cases with base, subcommand cases with the subcommand', () => {
    for (const c of cases) {
      const flagged = c.argv.some((t) => t.startsWith('-') && t !== '-');
      if (!flagged) expect(c.features, JSON.stringify(c.argv)).toEqual(['base']);
      else expect(c.features, JSON.stringify(c.argv)).not.toContain('base');
    }
    expect(cases.find((c) => c.argv.includes('--help'))?.features).toEqual(['opt.help']);
    const log = gen(gitLike).cases.map((c) => c.case).filter((c) => c.argv[0] === 'log');
    expect(log.length).toBeGreaterThan(0);
    for (const c of log) expect(c.features).toContain('cmd.log');
    expect(log.some((c) => c.features.includes('cmd.log.opt.oneline'))).toBe(true);
  });

  it('includes a call without the required positionals', () => {
    const spec = parseCliSpec({ version: 1, program: 'cp2', forms: [{ usage: 'cp2 SRC DST', args: [{ name: 'SRC', type: 'path', arity: '1' }, { name: 'DST', type: 'path', arity: '1' }] }] });
    const all = gen(spec).cases;
    expect(all.some((c) => c.strategy === 'form' && c.case.argv.length === 2)).toBe(true);
    expect(all.some((c) => c.strategy === 'invalid' && c.case.argv.length === 0)).toBe(true);
  });
});

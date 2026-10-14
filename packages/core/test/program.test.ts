import { lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseEnvironment, runProcess } from '../src/process-runner.js';
import {
  defaultProgramName,
  parseProgramCommand,
  pinPrograms,
  pinnedProcess,
  resolveProgram,
  type ResolvedProgram,
} from '../src/program.js';

describe('parseProgramCommand', () => {
  it('takes a path or a name on its own', () => {
    expect(parseProgramCommand('/usr/bin/sort')).toEqual({ executable: '/usr/bin/sort', args: [] });
    expect(parseProgramCommand('gsort')).toEqual({ executable: 'gsort', args: [] });
  });

  it("reads 'coreutils sort' as the sort tool of a multicall binary", () => {
    expect(parseProgramCommand('coreutils sort')).toEqual({ executable: 'coreutils', args: [], tool: 'sort' });
    expect(parseProgramCommand('/bin/busybox sort -s')).toEqual({ executable: '/bin/busybox', args: ['-s'], tool: 'sort' });
    expect(parseProgramCommand(['toybox', 'sort'])).toEqual({ executable: 'toybox', args: [], tool: 'sort' });
    expect(parseProgramCommand('coreutils [')).toEqual({ executable: 'coreutils', args: [], tool: '[' });
  });

  it('keeps fixed arguments of other programs, and options of a multicall binary, as arguments', () => {
    expect(parseProgramCommand('python3 tool.py')).toEqual({ executable: 'python3', args: ['tool.py'] });
    expect(parseProgramCommand('coreutils --help')).toEqual({ executable: 'coreutils', args: ['--help'] });
    expect(parseProgramCommand('busybox ./sort')).toEqual({ executable: 'busybox', args: ['./sort'] });
  });

  it('splits on whitespace and honours quotes', () => {
    expect(parseProgramCommand(`  '/opt/my tools/sort'   -t "a b" `)).toEqual({ executable: '/opt/my tools/sort', args: ['-t', 'a b'] });
    expect(parseProgramCommand(`tool ''`)).toEqual({ executable: 'tool', args: [''] });
  });

  it('rejects an empty command and an unclosed quote', () => {
    expect(() => parseProgramCommand('  ')).toThrow(/empty/);
    expect(() => parseProgramCommand([])).toThrow(/empty/);
    expect(() => parseProgramCommand(`'/opt/sort`)).toThrow(/quote/);
  });
});

describe('resolveProgram and pinPrograms', () => {
  let root: string;
  let bin: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-program-')));
    bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\necho tool\n', { mode: 0o755 });
    writeFileSync(join(bin, 'notexec'), 'data', { mode: 0o644 });
    writeFileSync(join(bin, 'busybox'), '#!/bin/sh\necho multicall\n', { mode: 0o755 });
    symlinkSync('busybox', join(bin, 'sort'));
    mkdirSync(join(root, 'proj', 'build'), { recursive: true });
    writeFileSync(join(root, 'proj', 'build', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds a bare name on the PATH, and a relative path from the working directory', async () => {
    const onPath = await resolveProgram(parseProgramCommand('tool -x'), { pathEnv: `/nonexistent:${bin}` });
    expect(onPath).toEqual({ executable: 'tool', args: ['-x'], path: join(bin, 'tool'), realPath: join(bin, 'tool') });
    const relative = await resolveProgram(parseProgramCommand('./build/tool'), { cwd: join(root, 'proj') });
    expect(relative.path).toBe(join(root, 'proj', 'build', 'tool'));
  });

  it('says what is wrong when the program is missing or not executable', async () => {
    await expect(resolveProgram(parseProgramCommand('nosuchtool'), { pathEnv: bin })).rejects.toThrow(/nosuchtool.*not found on the PATH/);
    await expect(resolveProgram(parseProgramCommand(join(bin, 'nope')), {})).rejects.toThrow(/not found/);
    await expect(resolveProgram(parseProgramCommand(join(bin, 'notexec')), {})).rejects.toThrow(/not executable/);
    await expect(resolveProgram(parseProgramCommand(bin), {})).rejects.toThrow(/not executable/);
  });

  it('treats a link to a multicall binary as that binary running the tool of the link name', async () => {
    const program = await resolveProgram(parseProgramCommand(join(bin, 'sort')), {});
    expect(program.tool).toBe('sort');
    expect(program.realPath).toBe(join(bin, 'busybox'));
  });

  it('defaults the program name to the multicall tool if a side has one, else the reference basename', () => {
    const side = (path: string, tool?: string): ResolvedProgram => ({ executable: path, args: [], path, realPath: path, ...(tool ? { tool } : {}) });
    expect(defaultProgramName([side('/usr/bin/gnusort'), side('/opt/sort')])).toBe('gnusort');
    expect(defaultProgramName([side('/usr/bin/gnusort'), side('/usr/bin/coreutils', 'sort')])).toBe('sort');
    expect(defaultProgramName([side('/bin/busybox', 'sort'), side('/opt/x')])).toBe('sort');
  });

  it('links each side under the program name, in a directory of its own', async () => {
    const ref = await resolveProgram(parseProgramCommand(join(bin, 'tool')), {});
    const cand = await resolveProgram(parseProgramCommand(join(root, 'proj', 'build', 'tool') + ' --fast'), {});
    const { name, sides } = await pinPrograms(join(root, 'pin-1'), [ref, cand], { name: 'mytool' });
    expect(name).toBe('mytool');
    expect(sides[0]!.binDir).not.toBe(sides[1]!.binDir);
    expect(readlinkSync(join(sides[0]!.binDir, 'mytool'))).toBe(join(bin, 'tool'));
    expect(readlinkSync(join(sides[1]!.binDir, 'mytool'))).toBe(join(root, 'proj', 'build', 'tool'));
    expect(sides[1]!.args).toEqual(['--fast']);
    expect(sides[1]!.readOnlyPaths).toEqual([sides[1]!.binDir, join(root, 'proj', 'build', 'tool')]);
  });

  it('copies a multicall binary under the tool name, since some refuse a link of another name', async () => {
    const multi = await resolveProgram(parseProgramCommand(`${join(bin, 'busybox')} sort -s`), {});
    const { name, sides } = await pinPrograms(join(root, 'pin-2'), [multi]);
    expect(name).toBe('sort');
    const copy = join(sides[0]!.binDir, 'sort');
    expect(lstatSync(copy).isFile()).toBe(true);
    expect(lstatSync(copy).mode & 0o111).not.toBe(0);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(join(bin, 'busybox'), 'utf8'));
    expect(sides[0]!.args).toEqual(['-s']);
    expect(sides[0]!.readOnlyPaths).toEqual([sides[0]!.binDir]);
  });

  it('can pin into the same directory again', async () => {
    const ref = await resolveProgram(parseProgramCommand(join(bin, 'tool')), {});
    const multi = await resolveProgram(parseProgramCommand(`${join(bin, 'busybox')} tool`), {});
    await pinPrograms(join(root, 'pin-again'), [ref, multi]);
    const { sides } = await pinPrograms(join(root, 'pin-again'), [ref, multi]);
    expect(readlinkSync(join(sides[0]!.binDir, 'tool'))).toBe(join(bin, 'tool'));
    expect(lstatSync(join(sides[1]!.binDir, 'tool')).isFile()).toBe(true);
  });

  it('refuses a program name a multicall side cannot run as', async () => {
    const multi = await resolveProgram(parseProgramCommand(`${join(bin, 'busybox')} sort`), {});
    const other = await resolveProgram(parseProgramCommand(`${join(bin, 'busybox')} uniq`), {});
    await expect(pinPrograms(join(root, 'pin-3'), [multi], { name: 'gsort' })).rejects.toThrow(/runs only as "sort"/);
    await expect(pinPrograms(join(root, 'pin-4'), [multi, other])).rejects.toThrow(/runs only as "uniq"/);
  });

  it('refuses a program name that is not a plain file name', async () => {
    const ref = await resolveProgram(parseProgramCommand(join(bin, 'tool')), {});
    for (const name of ['', '.', '..', 'a/b']) {
      await expect(pinPrograms(join(root, 'pin-5'), [ref], { name })).rejects.toThrow(/program name/);
    }
  });

  it('runs the pinned program by its name, first on the PATH, with its fixed arguments first', () => {
    const pinned = { binDir: '/run-1/side-1', args: ['--fast'], readOnlyPaths: ['/run-1/side-1'] };
    const spec = pinnedProcess('tool', pinned, ['-n', 'in.txt'], { PATH: '/usr/bin:/bin', HOME: '/h' });
    expect(spec).toEqual({
      argv: ['tool', '--fast', '-n', 'in.txt'],
      env: { PATH: '/run-1/side-1:/usr/bin:/bin', HOME: '/h' },
      readOnlyPaths: ['/run-1/side-1'],
    });
    expect(pinnedProcess('tool', pinned, [], {}).env.PATH).toBe('/run-1/side-1');
  });
});

// The same program under two names prints two different error messages; pinned, it prints one.
describe('a program run under another name (no sandbox)', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-pin-run-')));
    mkdirSync(join(root, 'tools'));
    symlinkSync('/bin/cat', join(root, 'tools', 'kitty'));
    mkdirSync(join(root, 'work'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const ERROR_CASES = [['-Z'], ['missing-file'], ['--no-such-option']];

  it('gives the same output on error cases once both sides are pinned', async () => {
    const ref = await resolveProgram(parseProgramCommand('/bin/cat'), {});
    const cand = await resolveProgram(parseProgramCommand(join(root, 'tools', 'kitty')), {});
    const { name, sides } = await pinPrograms(join(root, 'pin'), [ref, cand]);
    expect(name).toBe('cat');
    const env = caseEnvironment({ home: join(root, 'work') });
    for (const argv of ERROR_CASES) {
      const [r, c] = await Promise.all(
        sides.map((side) => runProcess({ ...pinnedProcess(name, side, argv, env), cwd: join(root, 'work'), sandbox: { kind: 'none' } })),
      );
      expect(r!.exit).not.toBe(0);
      // BSD and GNU cat start with "cat: ", uutils with a usage line naming cat.
      expect(r!.stderr.toString()).toMatch(/\bcat\b/);
      expect(r!.stderr.toString()).not.toContain('kitty');
      expect({ exit: c!.exit, stdout: c!.stdout.toString(), stderr: c!.stderr.toString() }).toEqual({
        exit: r!.exit,
        stdout: r!.stdout.toString(),
        stderr: r!.stderr.toString(),
      });
    }
    // Control: run by their own paths, the two disagree.
    const unpinned = await Promise.all(
      ['/bin/cat', join(root, 'tools', 'kitty')].map((path) => runProcess({ argv: [path, '-Z'], cwd: join(root, 'work'), env, sandbox: { kind: 'none' } })),
    );
    expect(unpinned[0]!.stderr.toString()).not.toBe(unpinned[1]!.stderr.toString());
  });

  it('keeps nothing but the program in a pinned directory', async () => {
    const ref = await resolveProgram(parseProgramCommand('/bin/cat'), {});
    const { sides } = await pinPrograms(join(root, 'pin-only'), [ref]);
    expect(readdirSync(sides[0]!.binDir)).toEqual(['cat']);
    expect(readlinkSync(join(sides[0]!.binDir, 'cat'))).toBe(realpathSync('/bin/cat'));
  });
});

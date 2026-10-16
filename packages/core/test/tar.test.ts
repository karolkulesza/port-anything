import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTar, readTar, TarError, treeEntries, unpackTar, type TarEntry } from '../src/tar.js';

const file = (name: string, data: string): TarEntry => ({ type: 'file', name: Buffer.from(name), data: Buffer.from(data) });
const dir = (name: string): TarEntry => ({ type: 'dir', name: Buffer.from(name) });
const link = (name: string, target: string): TarEntry => ({ type: 'symlink', name: Buffer.from(name), target: Buffer.from(target) });
const hard = (name: string, target: string): TarEntry => ({ type: 'hardlink', name: Buffer.from(name), target: Buffer.from(target) });

describe('tar', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pa-tar-')));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const long = `${'d'.repeat(60)}/${'f'.repeat(120)}.txt`;

  it('packs a tree and unpacks it as it was, long names included', async () => {
    const src = join(scratch, 'src');
    mkdirSync(join(src, 'sub', 'd'.repeat(60)), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'a\n');
    writeFileSync(join(src, 'sub', long), 'long\n');
    writeFileSync(join(src, 'empty'), '');
    const entries = await treeEntries(src, 'case');
    expect(entries.map((e) => e.name.toString())).toEqual(['case', 'case/a.txt', 'case/empty', 'case/sub', `case/sub/${'d'.repeat(60)}`, `case/sub/${long}`]);
    await unpackTar(packTar(entries), join(scratch, 'out'));
    expect(readFileSync(join(scratch, 'out', 'case', 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(scratch, 'out', 'case', 'sub', long), 'utf8')).toBe('long\n');
    expect(readFileSync(join(scratch, 'out', 'case', 'empty'), 'utf8')).toBe('');
  });

  it("writes archives the system's tar reads", () => {
    const archive = join(scratch, 'a.tar');
    writeFileSync(archive, packTar([dir('case'), file('case/x', 'x\n'), dir(`case/${'d'.repeat(60)}`), file(`case/${long}`, 'long\n')]));
    mkdirSync(join(scratch, 'x'));
    execFileSync('tar', ['-xf', archive, '-C', join(scratch, 'x')]);
    expect(readFileSync(join(scratch, 'x', 'case', 'x'), 'utf8')).toBe('x\n');
    expect(readFileSync(join(scratch, 'x', 'case', long), 'utf8')).toBe('long\n');
  });

  it("reads what the system's tar wrote: long names, symlinks, hard links", async () => {
    const src = join(scratch, 'src');
    mkdirSync(join(src, 'd'.repeat(60)), { recursive: true });
    writeFileSync(join(src, long), 'long\n');
    writeFileSync(join(src, 'a'), 'a\n');
    linkSync(join(src, 'a'), join(src, 'hard'));
    symlinkSync('/etc/passwd', join(src, 'link'));
    const archive = execFileSync('tar', ['-cf', '-', '-C', src, '.'], { maxBuffer: 1 << 26 });
    const out = join(scratch, 'out');
    await unpackTar(archive, out);
    expect(readFileSync(join(out, long), 'utf8')).toBe('long\n');
    expect(readFileSync(join(out, 'hard'), 'utf8')).toBe('a\n');
    expect(readlinkSync(join(out, 'link'))).toBe('/etc/passwd');
  });

  // macOS file systems refuse names that aren't UTF-8.
  it.runIf(process.platform === 'linux')('keeps a name that is not UTF-8', async () => {
    const name = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9])]);
    await unpackTar(packTar([{ type: 'file', name, data: Buffer.from('latin\n') }]), join(scratch, 'out'));
    expect(readFileSync(Buffer.concat([Buffer.from(join(scratch, 'out', '/')), name]), 'utf8')).toBe('latin\n');
  });

  it('writes nothing outside its directory, whatever the archive says', async () => {
    const victim = join(scratch, 'victim');
    mkdirSync(victim);
    const hostile: TarEntry[][] = [
      [file(join(victim, 'abs'), 'x')],
      [file('../victim/up', 'x')],
      [dir('a'), file('a/../../victim/up', 'x')],
      [link('l', victim), file('l/through', 'x')],
      [link('l', victim), dir('l/sub')],
      [link('l', victim), file('l', 'x')],
      [hard('h', join(victim, 'secret'))],
      [hard('h', '../victim/secret')],
      [file('f', 'x'), file('f', 'y')],
      [file('nodir/f', 'x')],
    ];
    writeFileSync(join(victim, 'secret'), 'secret\n');
    for (const [i, entries] of hostile.entries()) {
      await expect(unpackTar(packTar(entries), join(scratch, `out-${i}`)), JSON.stringify(entries.map((e) => e.name.toString()))).rejects.toThrow();
    }
    expect(readdirSync(victim)).toEqual(['secret']);
    // The hard links copied nothing.
    expect(readdirSync(join(scratch, 'out-6'))).toEqual([]);
    expect(readdirSync(join(scratch, 'out-7'))).toEqual([]);
    // An existing directory isn't unpacked into.
    await expect(unpackTar(packTar([file('x', 'x')]), victim)).rejects.toThrow(/EEXIST/);
  });

  it('refuses an archive with a bad checksum, cut short, or without an end', () => {
    const archive = packTar([file('a', 'abc')]);
    const bad = Buffer.from(archive);
    bad[0] = 0x62;
    expect(() => readTar(bad)).toThrow(TarError);
    expect(() => readTar(archive.subarray(0, 514))).toThrow(/ends inside a member/);
    expect(() => readTar(archive.subarray(0, 1024))).toThrow(/no end marker/);
    expect(readTar(archive).map((e) => e.name.toString())).toEqual(['a']);
  });
});

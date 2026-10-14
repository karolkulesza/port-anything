import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { DESTRUCTIVE_SUBCOMMANDS, DESTRUCTIVE_TOOLS, DestructiveToolError, assertNotDestructive, destructiveCommand } from '../src/destructive.js';

describe('destructiveCommand', () => {
  it('names the tools the plan lists, and finds them by path or GNU prefix', () => {
    for (const tool of ['rm', 'dd', 'mkfs', 'shred']) expect(DESTRUCTIVE_TOOLS).toContain(tool);
    expect(destructiveCommand(['rm'])).toBe('rm');
    expect(destructiveCommand(['/bin/rm', '-rf', 'x'])).toBe('rm');
    expect(destructiveCommand(['grm'])).toBe('rm');
    expect(destructiveCommand(['gshred'])).toBe('shred');
    expect(destructiveCommand(['mkfs.ext4'])).toBe('mkfs');
    expect(destructiveCommand(['/usr/sbin/mkfs.vfat'])).toBe('mkfs');
  });

  it('looks through multicall binaries and privilege wrappers', () => {
    expect(destructiveCommand(['busybox', 'rm'])).toBe('rm');
    expect(destructiveCommand(['/usr/bin/coreutils', 'dd'])).toBe('dd');
    expect(destructiveCommand(['toybox', 'sort'])).toBeNull();
    expect(destructiveCommand(['sudo'])).toBe('sudo');
  });

  it('finds destructive subcommands, skipping flags before them', () => {
    expect(DESTRUCTIVE_SUBCOMMANDS).toContainEqual(['git', 'push']);
    expect(destructiveCommand(['git', 'push'])).toBe('git push');
    expect(destructiveCommand(['git', '--no-pager', 'push', 'origin'])).toBe('git push');
    expect(destructiveCommand(['/usr/bin/git', 'clean', '-fdx'])).toBe('git clean');
    expect(destructiveCommand(['git', 'log'])).toBeNull();
    expect(destructiveCommand(['git'])).toBeNull();
  });

  it('leaves ordinary tools alone', () => {
    for (const argv of [['sort'], ['wc', '-l'], ['jq', '.'], ['rmdir-lookalike'], ['ddate'], ['firm']]) {
      expect(destructiveCommand(argv), argv.join(' ')).toBeNull();
    }
    expect(destructiveCommand([])).toBeNull();
  });
});

describe('assertNotDestructive', () => {
  it('refuses a denylisted tool without iKnow, with a config error that names --i-know', () => {
    const run = () => assertNotDestructive(['rm']);
    expect(run).toThrow(DestructiveToolError);
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/rm.*--i-know/s);
  });

  it('lets a denylisted tool through with iKnow, and ordinary tools always', () => {
    expect(() => assertNotDestructive(['rm'], { iKnow: true })).not.toThrow();
    expect(() => assertNotDestructive(['sort'])).not.toThrow();
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, readConfigFile } from '../src/config.js';
import { HISTORY_GITATTRIBUTES } from '../src/history.js';
import { initProject } from '../src/init.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-init-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8');

describe('initProject', () => {
  it('writes the config, .port-anything/, and the .gitattributes and .gitignore lines', async () => {
    const steps = await initProject('tool', { reference: './tool/bin/tool', candidates: ['./port/target/release/tool'], cwd: root });
    expect(steps).toEqual([
      { path: 'port-anything.yaml', action: 'created' },
      { path: '.port-anything/', action: 'created' },
      { path: '.gitattributes', action: 'created', added: ['.port-anything/history.jsonl merge=union'] },
      { path: '.gitignore', action: 'created', added: ['.port-anything/cache/', '.port-anything/runs/', '.port-anything/tmp/'] },
    ]);
    // Executable paths are typed from the current directory and stored from the project's.
    expect(read('tool', 'port-anything.yaml')).toBe(
      ['version: 1', 'reference:', '  cmd: ./bin/tool', 'candidate:', '  cmd: ../port/target/release/tool', 'sandbox:', '  mode: local', ''].join('\n'),
    );
    expect(statSync(join(root, 'tool', '.port-anything')).isDirectory()).toBe(true);
    expect(read('tool', '.gitattributes')).toBe(`${HISTORY_GITATTRIBUTES}\n`);
    expect(read('tool', '.gitignore')).toBe('.port-anything/cache/\n.port-anything/runs/\n.port-anything/tmp/\n');
    expect(await readConfigFile(join(root, 'tool'))).toMatchObject({ reference: { cmd: './bin/tool' }, candidate: { cmd: '../port/target/release/tool' } });
  });

  it('keeps names looked up on the PATH, absolute paths and arguments as typed, and lists several candidates', async () => {
    await initProject('.', { reference: 'coreutils sort', candidates: ['/usr/bin/sort -s', "python3 'my tool.py'"], cwd: root });
    expect(await readConfigFile(root)).toMatchObject({
      reference: { cmd: ['coreutils', 'sort'] },
      candidates: [{ cmd: ['/usr/bin/sort', '-s'] }, { cmd: ['python3', 'my tool.py'] }],
    });
  });

  it('writes no candidate when none is given', async () => {
    await initProject('.', { reference: 'sort', cwd: root });
    expect(read('port-anything.yaml')).toBe('version: 1\nreference:\n  cmd: sort\nsandbox:\n  mode: local\n');
  });

  it('adds only missing lines to existing files, after a final newline, and changes nothing the second time', async () => {
    writeFileSync(join(root, '.gitattributes'), '*.png binary');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.port-anything/runs/\n');
    const first = await initProject('.', { reference: 'sort', cwd: root });
    expect(first.slice(2)).toEqual([
      { path: '.gitattributes', action: 'updated', added: [HISTORY_GITATTRIBUTES] },
      { path: '.gitignore', action: 'updated', added: ['.port-anything/cache/', '.port-anything/tmp/'] },
    ]);
    expect(read('.gitattributes')).toBe(`*.png binary\n${HISTORY_GITATTRIBUTES}\n`);
    expect(read('.gitignore')).toBe('node_modules/\n.port-anything/runs/\n.port-anything/cache/\n.port-anything/tmp/\n');

    const before = [read('port-anything.yaml'), read('.gitattributes'), read('.gitignore')];
    expect(await initProject('.', { cwd: root })).toEqual([
      { path: 'port-anything.yaml', action: 'unchanged' },
      { path: '.port-anything/', action: 'unchanged' },
      { path: '.gitattributes', action: 'unchanged' },
      { path: '.gitignore', action: 'unchanged' },
    ]);
    expect([read('port-anything.yaml'), read('.gitattributes'), read('.gitignore')]).toEqual(before);
  });

  it('counts any .gitattributes line giving the history merge=union, but not one without it', async () => {
    writeFileSync(join(root, '.gitattributes'), '/.port-anything/history.jsonl  -diff merge=union\n');
    expect((await initProject('.', { reference: 'sort', cwd: root }))[2]).toEqual({ path: '.gitattributes', action: 'unchanged' });

    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, '.gitattributes'), '.port-anything/history.jsonl -diff\n');
    expect((await initProject('other', { reference: 'sort', cwd: root }))[2]).toMatchObject({ action: 'updated' });
    expect(read('other', '.gitattributes')).toBe(`.port-anything/history.jsonl -diff\n${HISTORY_GITATTRIBUTES}\n`);
  });

  it('makes git merge the history by union', async () => {
    await initProject('.', { reference: 'sort', cwd: root });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    expect(git('check-attr', 'merge', '--', '.port-anything/history.jsonl')).toBe('.port-anything/history.jsonl: merge: union\n');
  });

  it('refuses to replace a config, to start without a reference, or a project path that is a file', async () => {
    await initProject('.', { reference: 'sort', cwd: root });
    const config = read('port-anything.yaml');
    await expect(initProject('.', { reference: 'other', cwd: root })).rejects.toThrow(/already exists; edit it/);
    await expect(initProject('.', { candidates: ['other'], cwd: root })).rejects.toThrow(ConfigError);
    expect(read('port-anything.yaml')).toBe(config);

    await expect(initProject('fresh', { cwd: root })).rejects.toThrow(/give the reference with --ref/);
    expect(existsSync(join(root, 'fresh'))).toBe(false);

    writeFileSync(join(root, 'file'), '');
    await expect(initProject('file', { reference: 'sort', cwd: root })).rejects.toThrow(/Cannot create the project directory/);
    await expect(initProject('fresh', { reference: "sort 'x", cwd: root })).rejects.toThrow(/Unclosed ' quote/);
    expect(existsSync(join(root, 'fresh'))).toBe(false);
  });
});

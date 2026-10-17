import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '@port-anything/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-init-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('port-anything init', () => {
  it('sets up the project directory and lists what it wrote', async () => {
    const result = await run(['init', 'tool', '--ref', './tool/bin/tool', '--candidate', './tool/port/tool'], { cwd: root });
    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        'Set up tool:',
        '  port-anything.yaml: created',
        '  .port-anything/: created',
        '  .gitattributes: created with .port-anything/history.jsonl merge=union',
        '  .gitignore: created with .port-anything/cache/, .port-anything/runs/, .port-anything/probes/, .port-anything/tmp/',
        'Next: add cases to port-anything/recorded/*.jsonl, then run port-anything run.',
        '',
      ].join('\n'),
      stderr: '',
    });
    expect(readFileSync(join(root, 'tool', 'port-anything.yaml'), 'utf8')).toContain('reference:\n  cmd: ./bin/tool\ncandidate:\n  cmd: ./port/tool\n');

    const again = await run(['init', 'tool'], { cwd: root });
    expect(again).toEqual({
      exitCode: 0,
      stdout: ['Set up tool:', ...['port-anything.yaml', '.port-anything/', '.gitattributes', '.gitignore'].map((p) => `  ${p}: already there`), ''].join('\n'),
      stderr: '',
    });
  });

  it('exits 3 for bad arguments and for what it would overwrite', async () => {
    const usage = /Usage: port-anything init <dir> --ref <cmd> \[--candidate <cmd>\]…/;
    expect(await run(['init', '--ref', 'sort'], { cwd: root })).toEqual({ exitCode: 3, stdout: '', stderr: expect.stringMatching(usage) });
    expect(await run(['init', 'a', 'b', '--ref', 'sort'], { cwd: root })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/Give one project directory/) });
    expect(await run(['init', '.', '--frobnicate'], { cwd: root })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(usage) });
    expect(await run(['init', '.', '--ref', 'sort', '--ci'], { cwd: root })).toEqual({
      exitCode: 3,
      stdout: '',
      stderr: 'port-anything init: --ci is not available yet in this version of port-anything init.\n',
    });
    expect(await run(['init', '.'], { cwd: root })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/^port-anything init: No port-anything\.yaml in .* give the reference with --ref/) });
    expect((await run(['init', '.', '--ref', 'sort'], { cwd: root })).exitCode).toBe(0);
    expect(await run(['init', '.', '--ref', 'other'], { cwd: root })).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/already exists; edit it/) });
  });

  it('lets two branches that each ran the corpus merge without conflict (done when)', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'tool'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    mkdirSync(join(root, 'port-anything', 'recorded'), { recursive: true });
    writeFileSync(join(root, 'port-anything', 'recorded', 'recorded.jsonl'), '{"argv":["hi"],"origin":"recorded"}\n');
    expect((await run(['init', '.', '--ref', './bin/tool', '--candidate', './bin/tool'], { cwd: root })).exitCode).toBe(0);
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'set up');

    const runIds: string[] = [];
    for (const branch of ['a', 'b']) {
      git('checkout', '-q', '-b', branch, 'main');
      const result = await run(['run', '--no-sandbox', '--json'], { cwd: root });
      expect(result.exitCode).toBe(0);
      runIds.push(JSON.parse(result.stdout).run_id);
      git('add', '-A');
      // Only the history changed: the runs and the cache are git-ignored.
      expect(git('diff', '--cached', '--name-only')).toBe('.port-anything/history.jsonl\n');
      git('commit', '-q', '-m', `run on ${branch}`);
    }
    git('checkout', '-q', 'a');
    git('merge', '-q', '--no-edit', 'b');
    expect(git('status', '--porcelain')).toBe('');
    const history = await readHistory(root);
    expect(history.damaged).toEqual([]);
    expect(history.entries.map((e) => e.run_id)).toEqual(runIds);
    // Each branch ran on the commit it started from.
    const main = git('rev-parse', 'main').trim();
    expect(history.entries.map((e) => e.candidates[0]!.sha)).toEqual([main, main]);
  });
});

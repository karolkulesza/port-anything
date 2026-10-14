import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_GITATTRIBUTES, appendHistory, gitHead, historyPath, readHistory, type HistoryEntry } from '../src/history.js';

const SHA = 'c'.repeat(40);

const entry = (runId: string, parity: number | null = 0.5): HistoryEntry => ({
  version: 1,
  run_id: runId,
  created: '2026-10-14T19:02:03.456Z',
  cases: 10,
  candidates: [{ command: './port', sha: SHA, parity, features: 2, scored: 10, match: 5 }],
});

/** git in a throwaway repository, with no hooks, signing or user config from this machine. */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-history-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('appendHistory and readHistory', () => {
  it('appends one line per run, creating .port-anything/, and reads them back in order', async () => {
    expect(await readHistory(dir)).toEqual({ entries: [], damaged: [] });
    await appendHistory(dir, entry('20261014-190203-aaaa', 0.25));
    await appendHistory(dir, entry('20261014-190204-bbbb', null));
    const text = readFileSync(historyPath(dir), 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(JSON.parse(text.split('\n')[0]!)).toEqual(entry('20261014-190203-aaaa', 0.25));
    expect(await readHistory(dir)).toEqual({ entries: [entry('20261014-190203-aaaa', 0.25), entry('20261014-190204-bbbb', null)], damaged: [] });
  });

  it('starts a new line when the file was left without a final newline', async () => {
    mkdirSync(join(dir, '.port-anything'));
    writeFileSync(historyPath(dir), JSON.stringify(entry('20261014-190203-aaaa')));
    await appendHistory(dir, entry('20261014-190204-bbbb'));
    expect((await readHistory(dir)).entries.map((e) => e.run_id)).toEqual(['20261014-190203-aaaa', '20261014-190204-bbbb']);
  });

  it('skips blank lines, keeps unknown keys, and reports damaged lines by number', async () => {
    mkdirSync(join(dir, '.port-anything'));
    const later = { ...entry('20261014-190203-aaaa'), extra: { from: 'a later version' } };
    writeFileSync(historyPath(dir), [JSON.stringify(later), '', '{"version":1', JSON.stringify({ ...entry('20261014-190204-bbbb'), version: 2 }), ''].join('\n'));
    expect(await readHistory(dir)).toEqual({ entries: [later], damaged: [3, 4] });
  });

  it('refuses an entry that is not valid, writing nothing', async () => {
    await expect(appendHistory(dir, { ...entry('20261014-190203-aaaa'), run_id: 'latest' })).rejects.toThrow(/run_id/);
    await expect(appendHistory(dir, { ...entry('20261014-190203-aaaa'), candidates: [{ ...entry('x').candidates[0]!, sha: 'abc' }] })).rejects.toThrow(/sha/);
    expect(await readHistory(dir)).toEqual({ entries: [], damaged: [] });
  });
});

describe('gitHead', () => {
  it('is the checked-out commit of the repository holding a directory, else null', async () => {
    expect(await gitHead(dir)).toBeNull();
    git(dir, 'init', '-q', '-b', 'main');
    expect(await gitHead(dir)).toBeNull(); // no commit yet
    mkdirSync(join(dir, 'target', 'release'), { recursive: true });
    writeFileSync(join(dir, 'README'), 'x\n');
    git(dir, 'add', 'README');
    git(dir, 'commit', '-q', '-m', 'first');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    expect(await gitHead(dir)).toBe(head);
    expect(await gitHead(join(dir, 'target', 'release'))).toBe(head);
  });

  it('ignores GIT_DIR pointing at another repository', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, '.git');
    try {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pa-history-outside-')));
      try {
        expect(await gitHead(outside)).toBeNull();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe('history in git', () => {
  /** A repository whose main branch has one run in its history, and two branches made from it. */
  async function repoWithBranches(attributes: boolean): Promise<void> {
    git(dir, 'init', '-q', '-b', 'main');
    if (attributes) writeFileSync(join(dir, '.gitattributes'), `${HISTORY_GITATTRIBUTES}\n`);
    await appendHistory(dir, entry('20261014-190203-aaaa'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first run');
    for (const [branch, runId] of [
      ['a', '20261014-190204-bbbb'],
      ['b', '20261014-190205-cccc'],
    ] as const) {
      git(dir, 'checkout', '-q', '-b', branch, 'main');
      await appendHistory(dir, entry(runId));
      git(dir, 'commit', '-q', '-am', `run on ${branch}`);
    }
    git(dir, 'checkout', '-q', 'a');
  }

  it('two branches appending runs merge without conflict, keeping every run (done when)', async () => {
    await repoWithBranches(true);
    git(dir, 'merge', '-q', '--no-edit', 'b');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const history = await readHistory(dir);
    expect(history.damaged).toEqual([]);
    expect(history.entries.map((e) => e.run_id)).toEqual(['20261014-190203-aaaa', '20261014-190204-bbbb', '20261014-190205-cccc']);
  });

  it('conflicts without the .gitattributes line, so the line is what makes the merge clean', async () => {
    await repoWithBranches(false);
    expect(() => git(dir, 'merge', '-q', '--no-edit', 'b')).toThrow();
    expect(git(dir, 'status', '--porcelain')).toBe('UU .port-anything/history.jsonl\n');
  });
});

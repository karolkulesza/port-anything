import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_GITATTRIBUTES, appendHistory, gitDirty, gitHead, historyPath, readHistory, type HistoryEntry } from '../src/history.js';

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

  it('reads lines with and without the dirty flag, and refuses a dirty flag that is not a boolean', async () => {
    const old = entry('20261014-190203-aaaa');
    const marked = { ...entry('20261014-190204-bbbb'), candidates: [{ ...old.candidates[0]!, dirty: true }, { ...old.candidates[0]!, sha: null, dirty: null }] };
    mkdirSync(join(dir, '.port-anything'));
    writeFileSync(historyPath(dir), `${JSON.stringify(old)}\n${JSON.stringify(marked)}\n`);
    expect(await readHistory(dir)).toEqual({ entries: [old, marked], damaged: [] });
    await expect(appendHistory(dir, { ...old, candidates: [{ ...old.candidates[0]!, dirty: 'yes' as unknown as boolean }] })).rejects.toThrow(/dirty/);
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

describe('gitDirty', () => {
  beforeEach(() => {
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'project', '.port-anything'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.c'), 'int main;\n');
    writeFileSync(join(dir, 'project', '.port-anything', 'history.jsonl'), '');
    writeFileSync(join(dir, 'project', 'port-anything-badge.svg'), '<svg/>\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
  });

  it('is false on a clean tree and true once a tracked file is modified, staged or deleted, from any directory of it', async () => {
    mkdirSync(join(dir, 'target', 'release'), { recursive: true });
    writeFileSync(join(dir, 'untracked.txt'), 'not counted\n');
    expect(await gitDirty(join(dir, 'target', 'release'))).toBe(false);
    writeFileSync(join(dir, 'src', 'main.c'), 'int main = 1;\n');
    expect(await gitDirty(join(dir, 'target', 'release'))).toBe(true);
    git(dir, 'add', '-A');
    expect(await gitDirty(dir)).toBe(true);
    git(dir, 'commit', '-q', '-m', 'second');
    expect(await gitDirty(dir)).toBe(false);
    rmSync(join(dir, 'src', 'main.c'));
    expect(await gitDirty(dir)).toBe(true);
  });

  it('leaves out the paths it is told to ignore, globs in their last part', async () => {
    const project = join(dir, 'project');
    const ignore = [join(project, '.port-anything'), join(project, 'port-anything-badge*.svg')];
    writeFileSync(join(project, '.port-anything', 'history.jsonl'), '{}\n');
    writeFileSync(join(project, 'port-anything-badge.svg'), '<svg>changed</svg>\n');
    expect(await gitDirty(join(dir, 'src'), ignore)).toBe(false);
    expect(await gitDirty(join(dir, 'src'))).toBe(true);
    // An ignored path outside the repository changes nothing.
    expect(await gitDirty(join(dir, 'src'), [...ignore, join(tmpdir(), 'elsewhere')])).toBe(false);
    writeFileSync(join(dir, 'src', 'main.c'), 'int main = 2;\n');
    expect(await gitDirty(join(dir, 'src'), ignore)).toBe(true);
  });

  it('is null outside a repository and before the first commit', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pa-history-outside-')));
    try {
      expect(await gitDirty(outside)).toBeNull();
      git(outside, 'init', '-q', '-b', 'main');
      writeFileSync(join(outside, 'a'), 'a\n');
      git(outside, 'add', 'a');
      expect(await gitDirty(outside)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
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

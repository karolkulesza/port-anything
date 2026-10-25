import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlobStore, RECORDED_DIR, loadCommittedCases, parseCliSpec, parseConfigSource } from '@port-anything/core';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The docs pages walk through the examples, so their commands must keep working as written. Each
// page's sh blocks run in order, as a reader would run them from the top of a clone: in a temporary
// git repository holding the examples, with `port-anything` on the PATH. A text block right after
// an sh block is (part of) its output: every line of it without an ellipsis must show up. A command
// must exit 0 unless its line ends in `# exit code N`. Needs git, a C compiler and cargo.
const exec = promisify(execFile);
const docs = fileURLToPath(new URL('../../../docs/', import.meta.url));
const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const has = (cmd: string) => exec(cmd, ['--version']).then(() => true, () => false);
const toolchain = (await has('git')) && (await has('cc')) && (await has('cargo'));
const enabled = toolchain || process.env.CI !== undefined;
const sandboxed = process.platform !== 'linux' || process.env.PA_SANDBOX_TESTS === '1';

interface Block {
  lang: string;
  body: string;
}

/** The fenced code blocks of a page, in order, those in list items without their indent. */
function blocks(page: string): Block[] {
  return [...page.matchAll(/^( *)```(\w*)\n([\s\S]*?)^\1```$/gm)].map((m) => ({
    lang: m[2]!,
    body: m[3]!.replace(new RegExp(`^${m[1]}`, 'gm'), ''),
  }));
}

const pageBlocks = (name: string) => blocks(readFileSync(join(docs, name), 'utf8'));

/** Whitespace runs folded to one space, so output alignment doesn't matter. */
const fold = (text: string) => text.replace(/[ \t]+/g, ' ').trim();

interface Shell {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Runs one command line from a page; `cd` moves the shell. Returns stdout and stderr together. */
async function runLine(shell: Shell, line: string): Promise<string> {
  const expected = Number(/#\s*exit code (\d+)\s*$/.exec(line)?.[1] ?? 0);
  const cd = /^cd\s+(\S+)$/.exec(line.trim());
  const command = cd === null ? line : `cd ${cd[1]} && pwd`;
  // On its own line, the redirect stays out of a trailing `# exit code N` comment.
  const result = await exec('sh', ['-c', `{ ${command}\n} 2>&1`], { cwd: shell.cwd, env: shell.env, maxBuffer: 64 * 1024 * 1024 }).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
  );
  expect(result.code, `${line}\n${result.out}`).toBe(expected);
  if (cd !== null) shell.cwd = result.out.trim();
  return result.out;
}

/** Runs a page's sh blocks in order, checking each against the text block after it. `edit` handles other blocks. */
async function walkThrough(shell: Shell, page: Block[], edit: (block: Block, shell: Shell) => void = () => {}): Promise<number> {
  let commands = 0;
  for (const [i, block] of page.entries()) {
    if (block.lang !== 'sh') {
      if (block.lang !== 'text' || page[i - 1]?.lang !== 'sh') edit(block, shell);
      continue;
    }
    let out = '';
    for (const line of block.body.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      out += await runLine(shell, line);
      commands++;
    }
    const shown = page[i + 1];
    if (shown?.lang !== 'text') continue;
    const outLines = out.split('\n').map(fold);
    for (const line of shown.body.split('\n')) {
      if (line.trim() === '' || line.includes('…')) continue;
      expect(outLines, `output of\n${block.body}`).toContain(fold(line));
    }
  }
  return commands;
}

describe('the docs pages', () => {
  it('show configs that parse', () => {
    for (const name of ['refactor-guard.md', 'library-drivers.md']) {
      const configs = pageBlocks(name).filter((b) => b.lang === 'yaml' && b.body.startsWith('version: 1'));
      expect(configs.length, name).toBeGreaterThan(0);
      for (const { body } of configs) expect(() => parseConfigSource(body), `${name}:\n${body}`).not.toThrow();
    }
  });

  it('show a CLI spec and recorded cases that load', async () => {
    const page = pageBlocks('cli-spec.md');
    const specs = page.filter((b) => b.lang === 'yaml');
    expect(specs).toHaveLength(1);
    expect(parseCliSpec(parseYaml(specs[0]!.body)).forms[0]!.args.map((a) => a.arity)).toEqual(['1', '*']);
    const lines = page.find((b) => b.lang === 'jsonl')!.body;
    const project = mkdtempSync(join(tmpdir(), 'pa-docs-cases-'));
    try {
      mkdirSync(join(project, RECORDED_DIR), { recursive: true });
      writeFileSync(join(project, RECORDED_DIR, 'docs.jsonl'), lines);
      const cases = await loadCommittedCases(project, new BlobStore(join(project, 'cache')));
      expect(cases).toHaveLength(lines.trim().split('\n').length);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe.runIf(enabled)('the docs pages, run as written', () => {
  let root: string;
  let shell: () => Shell;

  beforeAll(async () => {
    if (!toolchain) throw new Error('The docs pages need git, cc and cargo on the PATH.');
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-docs-')));
    const repo = join(root, 'repo');
    // Build output and run state are left out, as a fresh clone has none.
    cpSync(examples, join(repo, 'examples'), {
      recursive: true,
      filter: (src) => {
        const path = relative(examples, src).split(sep).join('/');
        return !/(^|\/)(target|\.port-anything)(\/|$)|^wc-lite\/ref\/wc-lite$|^durations\/ref\/dur-driver$/.test(path);
      },
    });
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Where Linux has no usable sandbox (CI without PA_SANDBOX_TESTS), the runs go without one.
    writeFileSync(
      join(bin, 'port-anything'),
      `#!/bin/sh\n${sandboxed ? '' : 'case "$1" in compare|run) set -- "$@" --no-sandbox ;; esac\n'}exec '${process.execPath}' '${binPath}' "$@"\n`,
    );
    chmodSync(join(bin, 'port-anything'), 0o755);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.PATH = `${bin}:${process.env.PATH}`;
    const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env });
    await git('init', '-q');
    await git('add', '-A');
    await git('-c', 'user.name=docs', '-c', 'user.email=docs@example.com', 'commit', '-q', '-m', 'examples');
    shell = () => ({ cwd: repo, env });
  }, 60_000);
  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('refactor guard: compare --ref git:HEAD catches the change to the example', async () => {
    const page = pageBlocks('refactor-guard.md');
    let edits = 0;
    // The C block is the edit the page asks for: it replaces the function that starts with its first line.
    const commands = await walkThrough(shell(), page, (block, sh) => {
      if (block.lang !== 'c') return;
      const file = join(sh.cwd, 'ref', 'wc-lite.c');
      const source = readFileSync(file, 'utf8');
      const first = block.body.split('\n')[0]!;
      const start = source.indexOf(`${first}\n`);
      expect(start, first).toBeGreaterThanOrEqual(0);
      const end = source.indexOf('\n}\n', start) + 3;
      writeFileSync(file, source.slice(0, start) + block.body + source.slice(end));
      edits++;
    });
    expect(edits).toBe(1);
    expect(commands).toBeGreaterThanOrEqual(5);
  }, 600_000);

  it('library drivers: the durations example runs as shown', async () => {
    const commands = await walkThrough(shell(), pageBlocks('library-drivers.md'));
    expect(commands).toBeGreaterThanOrEqual(5);
  }, 600_000);
});

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, initProject, readConfigFile, type InitStep } from '@port-anything/core';
import { CI_WORKFLOW_FILE, ciWorkflow, codeownersLines, projectPath, repositoryRoot } from './ci-template.js';
import type { CliResult } from './run-command.js';
import { TOOL_VERSION } from './version.js';

export const USAGE = 'Usage: port-anything init <dir> --ref <cmd> [--candidate <cmd>]… [--ci]';

/** The owner the suggested CODEOWNERS lines name, for the user to replace. */
const OWNER_PLACEHOLDER = '@your-github-handle';

/**
 * `port-anything init <dir> --ref <cmd> [--candidate <cmd>]… [--ci]`: sets up a project directory
 * (see `initProject`) and lists what it wrote. Run again in a set-up project, without `--ref`, it
 * only adds what is missing. With `--ci`, it also writes a GitHub Actions workflow at the root of
 * the git repository (see `ciWorkflow`), unless one is there, and prints the CODEOWNERS lines to
 * add. Exit code 0, or 3 for bad arguments or what it can't write.
 */
export async function initCommand(argv: readonly string[], options: { cwd: string }): Promise<CliResult> {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: { ref: { type: 'string' }, candidate: { type: 'string', multiple: true }, ci: { type: 'boolean' } },
        strict: true,
        allowPositionals: true,
      });
    } catch (e) {
      throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    if (positionals.length !== 1) throw new ConfigError(`Give one project directory.\n${USAGE}`);
    const dir = positionals[0]!;
    const steps = await initProject(dir, {
      ...(values.ref === undefined ? {} : { reference: values.ref }),
      candidates: values.candidate ?? [],
      cwd: options.cwd,
    });
    const lines = [`Set up ${dir}:`, ...steps.map(describe)];
    const notes = values.ci === true ? await setUpCi(resolve(options.cwd, dir), steps, lines) : [];
    if (steps[0]!.action === 'created') lines.push('Next: add cases to port-anything/recorded/*.jsonl, then run port-anything run.');
    lines.push(...notes);
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof ConfigError) return { exitCode: 3, stdout: '', stderr: `port-anything init: ${e.message}\n` };
    throw e;
  }
}

function describe(step: InitStep): string {
  if (step.action === 'unchanged') return `  ${step.path}: already there`;
  if (step.added === undefined) return `  ${step.path}: ${step.action}`;
  return `  ${step.path}: ${step.action === 'created' ? 'created with' : 'added'} ${step.added.join(', ')}`;
}

/**
 * Writes the CI workflow unless the repository has it, adding its line to `lines`, and returns what
 * to print after: the suggested CODEOWNERS lines, and what the config still needs for CI.
 */
async function setUpCi(projectDir: string, steps: InitStep[], lines: string[]): Promise<string[]> {
  const root = await repositoryRoot(projectDir);
  const base = root ?? projectDir;
  const project = projectPath(base, projectDir);
  const file = join(base, CI_WORKFLOW_FILE);
  const step: InitStep = { path: relative(projectDir, file), action: 'created' };
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, ciWorkflow({ project, version: TOOL_VERSION }), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError(`Cannot write ${file}: ${(e as Error).message}`);
    step.action = 'unchanged';
  }
  steps.push(step);
  lines.push(describe(step));

  const config = await readConfigFile(projectDir);
  const notes: string[] = [];
  if (root === undefined) notes.push(`Not in a git repository: move ${CI_WORKFLOW_FILE.split('/')[0]}/ to the root of the repository, where GitHub looks for workflows.`);
  if (config.sandbox.mode !== 'container') {
    notes.push(
      'CI runs the cases in sandbox mode container, so the environment fingerprint is the same on every machine: set sandbox.mode to container in port-anything.yaml (with sandbox.image, reference.build and candidate.build), then freeze the corpus with port-anything baseline and commit .port-anything/MANIFEST.json.',
    );
  }
  if (config.compare.min_parity === undefined) notes.push('Without compare.min_parity in port-anything.yaml, the CI run fails on any divergence: set it to the parity the port must keep.');
  notes.push(`Suggested CODEOWNERS lines (in .github/CODEOWNERS, with your handle or team for ${OWNER_PLACEHOLDER}), so that every change to what defines the score needs a review:`);
  notes.push(...codeownersLines(project, OWNER_PLACEHOLDER).map((line) => `  ${line}`));
  return notes;
}

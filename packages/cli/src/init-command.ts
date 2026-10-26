import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, DEFAULT_CONTAINER_IMAGE, initProject, readConfigFile, readManifest, type InitStep } from '@port-anything/core';
import { CI_WORKFLOW_FILE, DEFAULT_CI_RUNNER, ciRunner, ciWorkflow, codeownersLines, projectPath, repositoryRoot } from './ci-template.js';
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
    const ci = values.ci === true ? await ciTarget(resolve(options.cwd, dir)) : undefined; // before writing anything
    const steps = await initProject(dir, {
      ...(values.ref === undefined ? {} : { reference: values.ref }),
      candidates: values.candidate ?? [],
      cwd: options.cwd,
    });
    const lines = [`Set up ${dir}:`, ...steps.map(describe)];
    const notes = ci === undefined ? [] : await setUpCi(ci, steps, lines);
    if (steps[0]!.action === 'created') lines.push("Next: port-anything spec infer (the CLI spec, from the reference's help), then port-anything generate (cases from the spec; add your own to port-anything/recorded/*.jsonl), then port-anything run.");
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

/** Where `init --ci` puts the workflow, for a project directory. */
interface CiTarget {
  projectDir: string;
  /** The repository's root; undefined outside a repository. */
  root: string | undefined;
  /** The project directory relative to the root (or itself), as the workflow names it. */
  project: string;
}

/**
 * Where the workflow goes. The project path is written into the workflow's YAML, its upload globs
 * and the CODEOWNERS lines, so it may only have characters none of them treat specially.
 */
async function ciTarget(projectDir: string): Promise<CiTarget> {
  const root = await repositoryRoot(projectDir);
  const project = projectPath(root ?? projectDir, projectDir);
  if (!/^[A-Za-z0-9._/-]+$/.test(project) || project.split('/').includes('..')) {
    throw new ConfigError(`--ci needs a project directory whose path in the repository has only letters, digits, ".", "_", "-" and "/": "${project}" would be misread in the workflow or CODEOWNERS.`);
  }
  return { projectDir, root, project };
}

/**
 * Writes the CI workflow unless the repository has it, adding its line to `lines`, and returns what
 * to print after: what the config and the manifest still need for CI, and the suggested CODEOWNERS
 * lines. The runner's architecture follows the manifest's, when it was frozen in a container.
 */
async function setUpCi({ projectDir, root, project }: CiTarget, steps: InitStep[], lines: string[]): Promise<string[]> {
  const config = await readConfigFile(projectDir);
  const manifest = await readManifest(projectDir).catch(() => undefined);
  const frozen = manifest?.fingerprint.mode === 'container' ? manifest.fingerprint : undefined;
  const runner = frozen === undefined ? DEFAULT_CI_RUNNER : (ciRunner(frozen.arch) ?? DEFAULT_CI_RUNNER);

  const file = join(root ?? projectDir, CI_WORKFLOW_FILE);
  const step: InitStep = { path: relative(projectDir, file), action: 'created' };
  let existing: string | undefined;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, ciWorkflow({ project, version: TOOL_VERSION, runner }), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError(`Cannot write ${file}: ${(e as Error).message}`);
    step.action = 'unchanged';
    existing = await readFile(file, 'utf8').catch(() => '');
  }
  steps.push(step);
  lines.push(describe(step));

  const notes: string[] = [];
  if (root === undefined) notes.push(`Not in a git repository: move ${CI_WORKFLOW_FILE.split('/')[0]}/ to the root of the repository, where GitHub looks for workflows.`);
  if (config.sandbox.mode !== 'container') {
    notes.push(
      'CI runs the cases in sandbox mode container, so that its environment fingerprint can match the manifest: set sandbox.mode to container in port-anything.yaml (with sandbox.image, reference.build and candidate.build), then freeze the corpus with port-anything baseline and commit .port-anything/MANIFEST.json.',
    );
  } else {
    // verify is authoritative only on the image digest and architecture the manifest was frozen with.
    if (frozen === undefined) {
      notes.push(
        `CI's verify checks .port-anything/MANIFEST.json, frozen by port-anything baseline in sandbox mode container on the architecture CI runs on (amd64 for runs-on: ${DEFAULT_CI_RUNNER}; arm64 needs ${ciRunner('arm64')}): run baseline, commit the manifest, and check runs-on.`,
      );
    } else if (ciRunner(frozen.arch) === undefined) {
      notes.push(`The manifest was frozen on ${frozen.arch}, which no GitHub-hosted runner has: CI's verify will only warn. Run port-anything baseline on amd64 or arm64.`);
    } else if (existing !== undefined && !new RegExp(`^\\s*runs-on: ${runner}\\s*$`, 'm').test(existing)) {
      notes.push(`The manifest was frozen on ${frozen.arch}: set runs-on: ${runner} in ${CI_WORKFLOW_FILE}, or CI's verify will only warn.`);
    }
    const image = config.sandbox.image ?? DEFAULT_CONTAINER_IMAGE;
    if (!image.includes('@sha256:')) {
      const digest = frozen !== undefined && frozen.image.includes('@sha256:') ? frozen.image.slice(frozen.image.indexOf('@')) : undefined;
      notes.push(
        `sandbox.image ${image} is a tag, which moves when the image is published again, and then CI's verify only warns: pin it by digest${digest === undefined ? ' (image: <name>@sha256:<digest>)' : ` (image: ${image}${digest}, the one the manifest was frozen with)`}.`,
      );
    }
  }
  if (config.compare.min_parity === undefined) notes.push('Without compare.min_parity in port-anything.yaml, the CI run fails on any divergence: set it to the parity the port must keep.');
  notes.push(`Suggested CODEOWNERS lines (in .github/CODEOWNERS, with your handle or team for ${OWNER_PLACEHOLDER}), so that every change to what defines the score needs a review:`);
  notes.push(...codeownersLines(project, OWNER_PLACEHOLDER).map((line) => `  ${line}`));
  return notes;
}

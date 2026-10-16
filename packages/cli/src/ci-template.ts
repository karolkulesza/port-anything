import { stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { CONFIG_FILE, MANIFEST_FILE } from '@port-anything/core';

/** Where `init --ci` writes the workflow, relative to the repository's root. */
export const CI_WORKFLOW_FILE = '.github/workflows/port-anything.yml';

/**
 * The root of the git repository `dir` is in: the nearest directory up from it with a `.git`
 * (a directory, or a file in a worktree or submodule). Undefined outside a repository.
 */
export async function repositoryRoot(dir: string): Promise<string | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    if (await stat(join(at, '.git')).then(() => true, () => false)) return at;
    if (dirname(at) === at) return undefined;
  }
}

/** The project directory as the workflow and CODEOWNERS name it: relative to the root, `/`-separated, `.` for the root. */
export function projectPath(root: string, projectDir: string): string {
  const path = relative(root, projectDir).split(sep).join('/');
  return path === '' ? '.' : path;
}

/** The GitHub-hosted runner the workflow runs on unless the manifest was frozen on arm64. */
export const DEFAULT_CI_RUNNER = 'ubuntu-latest';

/**
 * The GitHub-hosted Linux runner of an architecture as the container engine names it, so that CI
 * runs the image's same platform as the machine that froze the manifest; undefined when there is none.
 */
export function ciRunner(arch: string): string | undefined {
  if (arch === 'amd64' || arch === 'x86_64') return DEFAULT_CI_RUNNER;
  if (arch === 'arm64' || arch === 'aarch64') return 'ubuntu-24.04-arm';
  return undefined;
}

/**
 * The GitHub Actions workflow `init --ci` writes. It recomputes the score from scratch on every
 * push and pull request, with this version of port-anything: `verify` (exit 2 when the cases or
 * the reference's frozen observations were changed), then a full `run`, which builds the reference
 * and the candidates in the image, runs the corpus and a fresh holdout from an unstored seed, and
 * fails on parity below `compare.min_parity` or a significant holdout gap. The report is uploaded
 * whatever the outcome. The holdout's own parity is never held to a threshold: a new seed moves it.
 */
export function ciWorkflow(options: { project: string; version: string; runner?: string }): string {
  const { project, version, runner = DEFAULT_CI_RUNNER } = options;
  const npx = `npx --yes port-anything@${version}`;
  const inProject = project === '.' ? '' : `${project}/`;
  const defaults =
    project === '.'
      ? ''
      : `
    defaults:
      run:
        working-directory: ${project}`;
  return `# Recomputes the parity score from the committed files on every push and pull request.
# Written by port-anything init --ci. It fails when:
#   - the cases or the reference's frozen output differ from .port-anything/${MANIFEST_FILE}
#     (port-anything verify, exit 2);
#   - a candidate's parity on the corpus is below compare.min_parity in ${CONFIG_FILE};
#   - a candidate does better on the corpus than on a fresh holdout generated from a seed that is
#     never stored, by more than chance allows (holdout.gap_alpha).
# Cases run in sandbox mode container, in the committed sandbox.image, so the environment
# fingerprint is the one the manifest was frozen with: same image digest, and a runner of the
# same architecture.
name: port-anything

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  parity:
    name: parity
    runs-on: ${runner}${defaults}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Check the corpus against the manifest
        run: ${npx} verify
      # Builds the reference and the candidates in the image (reference.build, candidate.build),
      # then runs the corpus and a fresh holdout.
      - name: Run the corpus and a fresh holdout
        run: ${npx} run
      - name: Write the report
        if: \${{ !cancelled() }}
        run: ${npx} report
      - name: Upload the report
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v7
        with:
          name: port-anything-report
          path: |
            ${inProject}port-anything-report.html
            ${inProject}port-anything-report.json
            ${inProject}port-anything-badge*.svg
            ${inProject}.port-anything/runs/
          if-no-files-found: ignore
`;
}

/**
 * The CODEOWNERS lines `init --ci` suggests: everything that defines the score (the config, the
 * CLI spec, the waivers, the seeds and the recorded cases, the manifest) and the workflow that
 * checks it, so that changing any of them needs a review by `owner`.
 */
export function codeownersLines(project: string, owner: string): string[] {
  const at = project === '.' ? '/' : `/${project}/`;
  return [`${at}${CONFIG_FILE}`, `${at}port-anything/`, `${at}.port-anything/${MANIFEST_FILE}`, `/${CI_WORKFLOW_FILE}`].map((path) => `${path} ${owner}`);
}

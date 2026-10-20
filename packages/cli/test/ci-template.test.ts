import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BlobStore, cacheDir, findContainerEngine, readConfigFile, writeManifest } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CI_WORKFLOW_FILE, ciWorkflow, codeownersLines } from '../src/ci-template.js';
import { loadCorpus } from '../src/corpus.js';
import { run } from '../src/run.js';
import { TOOL_VERSION } from '../src/version.js';

// Needs @port-anything/core and the CLI built (`pnpm build`): the workflow's steps run dist/bin.js.
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const NPX = `npx --yes port-anything@${TOOL_VERSION}`;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: { parity: { 'runs-on': string; defaults?: { run: { 'working-directory': string } }; steps: Step[] } };
}

describe('ciWorkflow', () => {
  it('runs verify, a full run and the report with this version, in the project directory', () => {
    const root = parse(ciWorkflow({ project: '.', version: TOOL_VERSION })) as Workflow;
    expect(Object.keys(root.on)).toEqual(['push', 'pull_request']);
    const job = root.jobs.parity;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.defaults).toBeUndefined();
    expect(job.steps.flatMap((s) => (s.run === undefined ? [] : [s.run]))).toEqual([`${NPX} verify`, `${NPX} run`, `${NPX} report`]);
    // The report is written and uploaded even when the run fails; nothing compares the holdout's own parity.
    expect(job.steps.filter((s) => s.if === '${{ !cancelled() }}').map((s) => s.name)).toEqual(['Write the report', 'Upload the report']);
    expect(ciWorkflow({ project: '.', version: TOOL_VERSION })).not.toMatch(/--holdout|fresh_cases|--no-sandbox/);

    const nested = parse(ciWorkflow({ project: 'tools/port', version: TOOL_VERSION })) as Workflow;
    expect(nested.jobs.parity.defaults).toEqual({ run: { 'working-directory': 'tools/port' } });
    expect((parse(ciWorkflow({ project: '.', version: TOOL_VERSION, runner: 'ubuntu-24.04-arm' })) as Workflow).jobs.parity['runs-on']).toBe('ubuntu-24.04-arm');
    expect(nested.jobs.parity.steps.at(-1)!.with!.path).toBe(
      'tools/port/port-anything-report.html\ntools/port/port-anything-report.json\ntools/port/port-anything-badge*.svg\ntools/port/.port-anything/runs/\n',
    );
  });

  it('suggests CODEOWNERS lines for everything that defines the score, and the workflow', () => {
    expect(codeownersLines('.', '@me')).toEqual(['/port-anything.yaml @me', '/port-anything/ @me', '/.port-anything/MANIFEST.json @me', '/.github/workflows/port-anything.yml @me']);
    expect(codeownersLines('tools/port', '@org/team')[0]).toBe('/tools/port/port-anything.yaml @org/team');
  });
});

/** actionlint from the PATH, else its image; undefined when neither is there. */
const engine = await findContainerEngine().catch(() => undefined);
const ACTIONLINT_IMAGE = 'rhysd/actionlint:1.7.12';
const actionlint: ((dir: string) => { status: number | null; output: string }) | undefined =
  spawnSync('actionlint', ['-version']).status === 0
    ? (dir) => {
        const r = spawnSync('actionlint', ['-color=false', CI_WORKFLOW_FILE], { cwd: dir, encoding: 'utf8' });
        return { status: r.status, output: `${r.stdout}${r.stderr}` };
      }
    : engine !== undefined
      ? (dir) => {
          // The image runs as its own user, and mkdtemp's directory is 0700: on Linux, where the
          // bind mount keeps permissions, it couldn't read the workflow.
          execFileSync('chmod', ['-R', 'a+rX', dir]);
          // --quiet: a runner without the image would otherwise print the pull notice on stderr.
          const r = spawnSync(engine, ['run', '--rm', '--quiet', '-v', `${dir}:/repo`, '-w', '/repo', ACTIONLINT_IMAGE, '-color=false', CI_WORKFLOW_FILE], { encoding: 'utf8' });
          return { status: r.status, output: `${r.stdout}${r.stderr}` };
        }
      : undefined;
const inLinuxCi = process.env.CI !== undefined && process.platform === 'linux';

describe.runIf(actionlint !== undefined || inLinuxCi)('the workflow init --ci writes', () => {
  it('passes actionlint, at the root of the repository and for a project in a subdirectory (done when)', { timeout: 300_000 }, async () => {
    if (actionlint === undefined) throw new Error('actionlint needs actionlint on the PATH, or Docker or Podman for its image.');
    for (const [project, arch] of [['.', 'amd64'], ['tools/port', 'arm64']] as const) {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pa-ci-lint-')));
      try {
        mkdirSync(join(repo, '.git'));
        const result = await run(['init', project, '--ref', 'sort'], { cwd: repo });
        expect(result.exitCode).toBe(0);
        // The arm64 runner label too, which the workflow gets for a manifest frozen on arm64.
        const fingerprint = { mode: 'container' as const, image: `sha256:${'a'.repeat(64)}`, arch, locale: null };
        await writeManifest(join(repo, project), { version: 1, tool_version: TOOL_VERSION, generator: null, normalizers: [], fingerprint, cases: [] });
        expect((await run(['init', project, '--ci'], { cwd: repo })).exitCode).toBe(0);
        expect(readFileSync(join(repo, CI_WORKFLOW_FILE), 'utf8')).toContain(`runs-on: ${arch === 'arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-latest'}\n`);
        const lint = actionlint(repo);
        expect(lint.output).toBe('');
        expect(lint.status).toBe(0);
        // It does find problems: a broken copy fails.
        writeFileSync(join(repo, CI_WORKFLOW_FILE), readFileSync(join(repo, CI_WORKFLOW_FILE), 'utf8').replace('runs-on:', 'runs_on:'));
        expect(actionlint(repo).status).not.toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});

// The reference: a small filter with flags, which `spec infer` reads from its --help.
const FROB = `if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -u, --upper     upper-case the output\\n  -n, --count=N   stop after N lines\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=; count=
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) ;;
    -u|--upper) upper=1 ;;
    -n|--count) [ $# -ge 2 ] || { echo "frob: option '$1' requires an argument" >&2; exit 2; }; count=$2; shift ;;
    --count=*) count=\${1#--count=} ;;
    -n*) count=\${1#-n} ;;
    --) shift; break ;;
    -?*) echo "frob: unrecognized option '$1'" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
case "$count" in ''|*[!0-9]*) [ -z "$count" ] || { echo "frob: invalid count '$count'" >&2; exit 2; } ;; esac
cat "$@" | if [ -n "$upper" ]; then tr 'a-z' 'A-Z'; else cat; fi | if [ -n "$count" ]; then awk -v n="$count" 'NR <= n'; else cat; fi
`;

/**
 * A lookup-table port: it knows the answers for the corpus's cases only. It hashes everything a
 * case gives it (the arguments, stdin and the files they name) and answers like the reference
 * when the hash is one of the corpus's, which are written into it; anything else gets a made-up
 * answer. It runs alone in its container, so it can't call the reference.
 */
const lookupPort = (keys: readonly string[]) => `#!/bin/sh
in=$(mktemp)
cat > "$in"
key=$({ printf '%s\\n' "$@"; cat "$in"; for a in "$@"; do [ -f "$a" ] && cat "$a"; done; } | sha256sum | cut -d' ' -f1)
case "$key" in
  ${keys.join('|')}) ;;
  *) rm -f "$in"; echo 'made up'; exit 0 ;;
esac
frob() {
${FROB}}
frob "$@" < "$in"
status=$?
rm -f "$in"
exit $status
`;

/** The hash `lookupPort` computes for a case, from its argv, stdin and the fixtures the argv names. */
async function caseKey(c: { argv: readonly string[]; stdin: string | null; fixtures: Readonly<Record<string, string>> }, store: BlobStore): Promise<string> {
  const hash = createHash('sha256');
  hash.update(c.argv.length === 0 ? '\n' : c.argv.map((a) => `${a}\n`).join(''));
  if (c.stdin !== null) hash.update(await store.get(c.stdin));
  for (const a of c.argv) {
    const fixture = c.fixtures[a.replace(/^\.\//, '')];
    if (fixture !== undefined) hash.update(await store.get(fixture));
  }
  return hash.digest('hex');
}

/**
 * Runs a job's steps the way GitHub Actions does on ubuntu-latest: each `run` in bash with
 * `-eo pipefail` in the job's working directory, with the published CLI replaced by this build; a
 * step runs only when every step before it passed, unless its `if` is `!cancelled()`. `uses` steps
 * are the runner's setup (checkout, Node) and the upload, which needs the files it names.
 */
async function runJob(repo: string, workflow: Workflow): Promise<{ failed: string | undefined; log: string }> {
  const job = workflow.jobs.parity;
  const dir = join(repo, job.defaults?.run['working-directory'] ?? '.');
  let failed: string | undefined;
  let log = '';
  for (const step of job.steps) {
    if (failed !== undefined && step.if !== '${{ !cancelled() }}') continue;
    if (step.run !== undefined) {
      expect(step.run).toContain(NPX);
      const script = step.run.replaceAll(NPX, `'${process.execPath}' '${binPath}'`);
      const result = await promisify(execFile)('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(
        (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
        (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: `${e.stdout}${e.stderr}` }),
      );
      log += `## ${step.name} (exit ${result.code})\n${result.out}\n`;
      if (result.code !== 0) failed ??= step.name;
    } else if (step.uses?.startsWith('actions/upload-artifact@') === true) {
      const paths = String(step.with!.path).trim().split('\n');
      expect(paths.some((p) => globSync(p, { cwd: repo }).length > 0)).toBe(true);
    }
  }
  return { failed, log };
}

// Builds nothing, but runs a few hundred cases in containers, several times over.
describe.runIf(engine !== undefined || inLinuxCi)('a repository with the workflow init --ci writes', () => {
  let repo: string;
  let project: string;
  let workflow: Workflow;
  const cli = (argv: string[]) => run(argv, { cwd: project });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  const setCandidate = (cmd: string) => {
    const file = join(project, 'port-anything.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/candidate: \{ cmd: \S+ \}/, `candidate: { cmd: ${cmd} }`));
  };

  beforeAll(async () => {
    if (engine === undefined) throw new Error('Sandbox mode container needs Docker or Podman running.');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pa-ci-repo-')));
    project = join(repo, 'port');
    mkdirSync(join(project, 'bin'), { recursive: true });
    writeFileSync(join(project, 'bin', 'frob'), `#!/bin/sh\n${FROB}`, { mode: 0o755 });
    writeFileSync(join(project, 'bin', 'frob-port'), `#!/bin/sh\n${FROB}`, { mode: 0o755 });
    git('init', '-q', '-b', 'main');
    writeFileSync(
      join(project, 'port-anything.yaml'),
      [
        'version: 1',
        'reference: { cmd: ./bin/frob }',
        'candidate: { cmd: ./bin/frob-port }',
        'sandbox: { mode: container, image: debian:12-slim }',
        'compare: { min_parity: 0.9 }',
        'corpus: { min_cases_per_feature: 5 }',
        'holdout: { fresh_cases: 200 }',
        '',
      ].join('\n'),
    );
    const init = await run(['init', 'port', '--ci'], { cwd: repo });
    expect(init.stderr).toBe('');
    expect(init.stdout).toContain(`  ../${CI_WORKFLOW_FILE}: created\n`);
    expect(init.stdout).not.toMatch(/sandbox\.mode|min_parity/); // the config is ready for CI
    workflow = parse(readFileSync(join(repo, CI_WORKFLOW_FILE), 'utf8')) as Workflow;
    expect(workflow.jobs.parity.defaults).toEqual({ run: { 'working-directory': 'port' } });

    // The project as it is committed: the spec, the generated corpus's settings and the manifest,
    // frozen in the image.
    for (const argv of [['spec', 'infer'], ['generate', '--budget', '80', '--seed', '7'], ['baseline']]) {
      const result = await cli(argv);
      expect(result.stderr, argv.join(' ')).toBe('');
      expect(result.exitCode, argv.join(' ')).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(project, '.port-anything', 'MANIFEST.json'), 'utf8')).fingerprint.mode).toBe('container');
    git('add', '-A');
    git('commit', '-q', '-m', 'port with CI');
  }, 900_000);
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  /** A fresh checkout, as CI starts from: nothing the .gitignore leaves out. */
  const checkout = () => {
    git('clean', '-qfdX');
    expect(existsSync(cacheDir(project))).toBe(false);
  };

  it('passes with a correct port', { timeout: 900_000 }, async () => {
    checkout();
    const { failed, log } = await runJob(repo, workflow);
    expect(failed, log).toBeUndefined();
    expect(log).toContain('manifest intact');
    expect(log).toMatch(/gap to the corpus .*: not significant/);
  });

  it('goes red on a lookup-table port that matches every case of the corpus (done when)', { timeout: 900_000 }, async () => {
    // The table: a key for every case of the corpus as the generator makes it from the committed seed.
    const store = new BlobStore(cacheDir(project));
    const corpus = await loadCorpus(project, await readConfigFile(project), { noSandbox: false });
    expect(corpus.length).toBeGreaterThan(40);
    const keys = await Promise.all(corpus.map((c) => caseKey(c, store)));
    writeFileSync(join(project, 'bin', 'frob-lookup'), lookupPort(keys), { mode: 0o755 });
    setCandidate('./bin/frob-lookup');
    git('add', '-A');
    git('commit', '-q', '-m', 'a port that knows the answers');

    checkout();
    const { failed, log } = await runJob(repo, workflow);
    expect(failed, log).toBe('Run the corpus and a fresh holdout');
    expect(log).toContain('manifest intact'); // nothing committed was tampered with
    expect(log).toMatch(/^candidate 1 \.\/bin\/frob-lookup: (\d+) of \1 cases match$/m); // perfect on the corpus
    expect(log).toMatch(/^ {2}compare\.min_parity 90\.0%: met$/m);
    expect(log).toMatch(/^ {2}gap to the corpus .*: SIGNIFICANT/m);
    expect(log).toContain('## Write the report (exit 0)'); // and the report of the failing run is there to upload
  });
});

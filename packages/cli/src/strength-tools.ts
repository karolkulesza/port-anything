import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ConfigError,
  applyMutant,
  isMutableSource,
  mapPool,
  parseElementsReport,
  resolveProgram,
  sampleMutants,
  sourceMutants,
  type MutantResult,
  type ProgramCommand,
  type SourceMutant,
} from '@port-anything/core';
import type { CheckOverrides, CheckSpec } from './strength-command.js';

/** What a mutation tool needs from `strength`. */
export interface ToolContext {
  projectDir: string;
  candidate: ProgramCommand;
  /** The candidate's build command (`candidate.build`), run from the project directory. */
  build?: string;
  reference: ProgramCommand;
  /** Scratch space for this measurement, inside the project; removed afterwards. */
  workDir: string;
  /** For `strength --check`; tools that run it as a command write it to a file first. */
  spec: CheckSpec;
  cliEntry: string;
  node: string;
  /** At most this many mutants (a fixed sample), where the tool builds one at a time. */
  mutants: number;
  /** Mutants tested at once. */
  jobs: number;
  caseTimeoutMs: number;
  /** Checks a mutant in this process (the generic fallback). */
  check: (spec: CheckSpec, overrides: CheckOverrides) => Promise<{ diverged?: { case: string; fields: string[] } }>;
}

export interface ToolRun {
  /** The tool and its version, as shown in the report. */
  tool: string;
  /** Mutants the tool can make of the candidate, before sampling. */
  generated: number;
  results: MutantResult[];
  notes: string[];
  /** Why there may be no mutant at all. */
  why?: string;
}

export interface Tool {
  /** Why this tool was picked over a better one, if it was. */
  notes: string[];
  run(): Promise<ToolRun>;
}

/**
 * Picks the mutation tool for the candidate's source: cargo-mutants when it is a Cargo package,
 * Stryker for a JS/TS package that has it installed, mull for C/C++ when mull and its clang are on
 * the PATH, else the generic source mutator. The source is found from the candidate's script (the
 * first argument that is a file) or else its executable, by walking up to a project file.
 */
export async function chooseTool(ctx: ToolContext): Promise<Tool> {
  const anchor = await sourceAnchor(ctx, ctx.candidate);
  // Not above the project when the candidate is in it: the project may sit in some other Cargo workspace.
  const cargo = findUp(dirname(anchor.path), (dir) => existsSync(join(dir, 'Cargo.toml')), isInside(ctx.projectDir, anchor.path) ? ctx.projectDir : undefined);
  if (cargo !== undefined) return cargoMutants(ctx, anchor, join(cargo, 'Cargo.toml'));
  const root = sourceRoot(ctx, anchor);
  const pkg = findUp(dirname(anchor.path), (dir) => existsSync(join(dir, 'package.json')), ctx.projectDir);
  if (pkg !== undefined && isScript(anchor.path, JS_FAMILY)) {
    const stryker = resolveFrom(pkg, '@stryker-mutator/core/package.json');
    if (stryker !== undefined) return strykerTool(ctx, anchor, pkg, stryker);
    return genericTool(ctx, anchor, root, [`Stryker is not installed for ${display(ctx, pkg)} (npm install --save-dev @stryker-mutator/core), so the generic source mutator ran.`]);
  }
  if (!anchor.script && (await sourceFiles(ctx, root, anchor.path)).some((f) => C_FAMILY.includes(extname(f)))) {
    const mull = findMull();
    if (mull !== undefined) return mullTool(ctx, root, mull);
    return genericTool(ctx, anchor, root, ['mull and its clang are not on the PATH, so the generic source mutator ran.']);
  }
  return genericTool(ctx, anchor, root, []);
}

const C_FAMILY = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'];
const JS_FAMILY = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];

/** The file a program's source is found from: its script when it has one, else its executable; `script` when it runs as it is. */
async function sourceAnchor(ctx: ToolContext, program: ProgramCommand): Promise<{ path: string; script: boolean }> {
  for (const arg of program.args) {
    const path = resolve(ctx.projectDir, arg);
    if (!arg.startsWith('-') && existsSync(path) && statSync(path).isFile()) return { path, script: true };
  }
  try {
    // An executable script (`./port/tool.py` with a #! line) runs as mutated too.
    const path = (await resolveProgram(program, { cwd: ctx.projectDir })).path;
    return { path, script: isMutableSource(path) };
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

const isScript = (path: string, extensions: readonly string[]) => extensions.includes(extname(path));

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function findUp(start: string, found: (dir: string) => boolean, stopAt?: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (found(dir)) return dir;
    if (dir === stopAt || dirname(dir) === dir) return undefined;
  }
}

const PROJECT_FILES = ['package.json', 'go.mod', 'pyproject.toml', 'setup.py', 'Makefile', 'CMakeLists.txt', 'meson.build', 'build.zig', 'Gemfile', 'pom.xml', 'build.gradle'];

/**
 * The candidate's source tree: the nearest directory above its script or executable with a
 * project file, not above the project directory, else the script's or executable's directory.
 * It must be inside the project, since the generic fallback mutates a copy of the project.
 */
function sourceRoot(ctx: ToolContext, anchor: { path: string }): string {
  if (!isInside(ctx.projectDir, anchor.path)) {
    throw new ConfigError(`The candidate's source (found from ${anchor.path}) is outside the project directory, so strength can't mutate a copy of it.`);
  }
  return findUp(dirname(anchor.path), (dir) => PROJECT_FILES.some((f) => existsSync(join(dir, f))), ctx.projectDir) ?? dirname(anchor.path);
}

// Never mutated or walked into: tool output, dependencies, the corpus and its cache.
const SKIP_DIRS = new Set(['.git', '.port-anything', 'port-anything', 'node_modules', 'target', 'build', 'dist', 'out', '__pycache__', 'vendor', '.stryker-tmp']);
const TEST_NAME = /(^|[._-])(test|tests|spec)([._-]|$)/i;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);

/**
 * The source files under `root` the generic fallback mutates (paths relative to `root`), leaving
 * out tests and the reference: its script or executable, and its source tree. That is the top
 * directory of the project holding the reference (`ref/` for `ref/bin/tool`), or else the
 * reference's own directory, whichever doesn't also hold the candidate (`candidate`, its script or
 * executable).
 */
async function sourceFiles(ctx: ToolContext, root: string, candidate: string): Promise<string[]> {
  const reference = await sourceAnchor(ctx, ctx.reference).then(
    (a) => a.path,
    () => undefined,
  );
  let referenceDir: string | undefined;
  if (reference !== undefined) {
    const top = isInside(ctx.projectDir, reference) ? join(ctx.projectDir, relative(ctx.projectDir, reference).split(sep)[0]!) : undefined;
    referenceDir = [top, dirname(reference)].find((dir) => dir !== undefined && dir !== reference && !isInside(dir, candidate));
  }
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !TEST_DIRS.has(entry.name) && path !== referenceDir) await walk(path);
      } else if (entry.isFile() && path !== reference && isMutableSource(entry.name) && !TEST_NAME.test(entry.name.replace(/\.[^.]+$/, ''))) {
        files.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  await walk(root);
  return files;
}

function display(ctx: ToolContext, path: string): string {
  return relative(ctx.projectDir, path) || '.';
}

function resolveFrom(dir: string, request: string): string | undefined {
  try {
    return createRequire(join(dir, 'package.json')).resolve(request);
  } catch {
    return undefined;
  }
}

interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program and returns its exit code and output, never throwing for a non-zero exit. */
function run(file: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Exec> {
  return new Promise((done, failed) => {
    execFile(file, [...args], { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 256 * 1024 * 1024, timeout: options.timeoutMs ?? 0 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        if (error.code === 'ENOENT') failed(new ConfigError(`${file} is not installed (not found on the PATH).`));
        else if (error.killed) done({ code: -1, stdout, stderr });
        else failed(error);
        return;
      }
      done({ code: error === null ? 0 : (error.code as number), stdout, stderr });
    });
  });
}

const tail = (text: string, lines = 30) => text.trimEnd().split('\n').slice(-lines).join('\n');

/** The environment a tool runs `strength --check` with. */
function checkEnv(ctx: ToolContext, specPath: string): NodeJS.ProcessEnv {
  return { ...process.env, PA_STRENGTH_NODE: ctx.node, PA_STRENGTH_CLI: ctx.cliEntry, PA_STRENGTH_SPEC: specPath };
}

async function writeSpec(ctx: ToolContext, spec: CheckSpec): Promise<string> {
  const path = join(ctx.workDir, `check-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify(spec));
  return path;
}

/** The test cargo-mutants runs for each mutant: `strength --check` on the binary it built. */
const cargoTest = (bin: string) => `// Written by port-anything strength: each mutant counts as caught when the corpus sees it.
use std::io::Write;
use std::process::Command;

#[test]
fn port_anything_corpus() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
    let out = Command::new(var("PA_STRENGTH_NODE"))
        .arg(var("PA_STRENGTH_CLI"))
        .args(["strength", "--check"])
        .arg(var("PA_STRENGTH_SPEC"))
        .arg("--executable")
        .arg(env!(${JSON.stringify(`CARGO_BIN_EXE_${bin}`)}))
        .output()
        .expect("node runs");
    let code = out.status.code().unwrap_or(-1);
    if code != 0 && code != 1 {
        // Not a catch: the check itself failed. One write, as parallel jobs append to the same file.
        let errors = std::env::var("PA_STRENGTH_ERRORS").unwrap_or_default();
        let text = format!("check exited {code}: {}\\n", String::from_utf8_lossy(&out.stderr).trim());
        let mut log = std::fs::OpenOptions::new().create(true).append(true).open(errors).unwrap();
        log.write_all(text.as_bytes()).unwrap();
    }
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&out.stdout));
}
`;

const CARGO_TEST_NAME = 'port_anything_corpus';

interface CargoMetadata {
  workspace_root: string;
  target_directory: string;
  packages: { name: string; manifest_path: string; targets: { name: string; kind: string[] }[] }[];
}

/**
 * cargo-mutants on a copy of the candidate's workspace, with a test added to its package that runs
 * `strength --check` on the binary of each mutant; only that test runs, so the package's own tests
 * don't count. Samples with `--re` when there are more mutants than asked for.
 */
async function cargoMutants(ctx: ToolContext, anchor: { path: string }, manifest: string): Promise<Tool> {
  return {
    notes: [],
    async run() {
      const version = await run('cargo', ['mutants', '--version'], { cwd: ctx.workDir });
      if (version.code !== 0) throw new ConfigError(`The candidate is a Cargo package, but cargo-mutants is not installed: cargo install --locked cargo-mutants\n${tail(version.stderr, 5)}`);
      const metadataRun = await run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest], { cwd: ctx.projectDir });
      if (metadataRun.code !== 0) throw new ConfigError(`cargo metadata failed for ${display(ctx, manifest)}:\n${tail(metadataRun.stderr)}`);
      const metadata = JSON.parse(metadataRun.stdout) as CargoMetadata;
      // The binary the candidate runs, by file name; the debug build cargo-mutants makes has the same name.
      const bin = anchor.path.split(sep).pop()!;
      const pkg = metadata.packages.find((p) => p.targets.some((t) => t.kind.includes('bin') && t.name === bin));
      if (pkg === undefined) throw new ConfigError(`No package in ${display(ctx, metadata.workspace_root)} builds a binary named ${bin} (the candidate's executable).`);

      const copy = join(ctx.workDir, 'cargo');
      const skip = [metadata.target_directory, join(metadata.workspace_root, '.git'), join(ctx.projectDir, '.port-anything')];
      await copyTree(metadata.workspace_root, copy, skip);
      const pkgDir = join(copy, relative(metadata.workspace_root, dirname(pkg.manifest_path)));
      await mkdir(join(pkgDir, 'tests'), { recursive: true });
      await writeFile(join(pkgDir, 'tests', `${CARGO_TEST_NAME}.rs`), cargoTest(bin));

      const common = ['mutants', '--dir', copy, '--package', pkg.name];
      const listed = await run('cargo', [...common, '--list'], { cwd: copy });
      if (listed.code !== 0) throw new ConfigError(`cargo mutants --list failed:\n${tail(listed.stderr)}`);
      const names = listed.stdout.split('\n').filter((l) => l !== '');
      const sample = sampleMutants(names, ctx.mutants);
      const specPath = await writeSpec(ctx, ctx.spec);
      const out = join(ctx.workDir, 'cargo-out');
      const args = [
        ...common,
        '--output',
        out,
        '--jobs',
        String(ctx.jobs),
        '--no-shuffle',
        `--cargo-test-arg=--test`,
        `--cargo-test-arg=${CARGO_TEST_NAME}`,
        // A mutant that hangs times out on its first case, which counts as caught; leave time for that.
        '--minimum-test-timeout',
        String(Math.ceil((2 * ctx.caseTimeoutMs) / 1000) + 20),
        ...(sample.length < names.length ? ['--re', `^(?:${sample.map(escapeRegex).join('|')})$`] : []),
      ];
      const result = await run('cargo', args, { cwd: copy, env: { ...checkEnv(ctx, specPath), PA_STRENGTH_ERRORS: ctx.spec.errors } });
      // 0: all caught, 2: some missed, 3: some timed out; 4: the unmutated candidate failed its check.
      if (result.code === 4) throw new ConfigError(`cargo-mutants: the unmutated candidate fails the check (it should match every case it matched before):\n${tail(result.stdout)}`);
      if (![0, 2, 3].includes(result.code)) throw new ConfigError(`cargo mutants exited ${result.code}:\n${tail(result.stdout)}\n${tail(result.stderr)}`);

      const results: MutantResult[] = [];
      for (const status of ['caught', 'missed', 'timeout', 'unviable'] as const) {
        const file = join(out, 'mutants.out', `${status}.txt`);
        if (!existsSync(file)) continue;
        for (const name of (await readFile(file, 'utf8')).split('\n')) if (name !== '') results.push({ name, status });
      }
      return { tool: version.stdout.trim(), generated: names.length, results, notes: [] };
    },
  };
}

const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** Quotes a word for the command line Stryker's command runner hands to a shell. */
const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * Stryker on the candidate's package with its command test runner, which runs `strength --check`
 * in Stryker's sandbox (a copy of the package) with the mutant switched on by environment. Stryker
 * builds once for all mutants, so every mutant is tested; `--mutants` doesn't apply.
 */
async function strykerTool(ctx: ToolContext, anchor: { path: string }, pkg: string, strykerPackage: string): Promise<Tool> {
  return {
    notes: [],
    async run() {
      const meta = JSON.parse(await readFile(strykerPackage, 'utf8')) as { version: string; bin: Record<string, string> };
      const bin = join(dirname(strykerPackage), meta.bin.stryker!);
      const mutate = (await sourceFiles(ctx, pkg, anchor.path)).filter((f) => isScript(f, JS_FAMILY));
      if (mutate.length === 0) return { tool: `Stryker ${meta.version}`, generated: 0, results: [], notes: [], why: `no JS/TS source in ${display(ctx, pkg)}` };
      const specPath = await writeSpec(ctx, { ...ctx.spec, root: pkg, passNewEnv: true });
      const report = join(ctx.workDir, 'stryker', 'mutation.json');
      const config = join(ctx.workDir, 'stryker.config.json');
      await writeFile(
        config,
        JSON.stringify({
          testRunner: 'command',
          commandRunner: { command: [ctx.node, ctx.cliEntry, 'strength', '--check', specPath].map(shellQuote).join(' ') },
          mutate,
          reporters: ['json'],
          jsonReporter: { fileName: report },
          coverageAnalysis: 'off',
          concurrency: ctx.jobs,
          timeoutMS: 2 * ctx.caseTimeoutMs + 20_000,
          tempDirName: '.stryker-tmp',
          cleanTempDir: 'always',
          plugins: [],
        }),
      );
      const result = await run(ctx.node, [bin, 'run', config], { cwd: pkg, env: checkEnv(ctx, specPath) });
      if (result.code !== 0 || !existsSync(report)) throw new ConfigError(`Stryker exited ${result.code}:\n${tail(result.stdout)}\n${tail(result.stderr)}`);
      const results = parseElementsReport(JSON.parse(await readFile(report, 'utf8')));
      return { tool: `Stryker ${meta.version}`, generated: results.length, results, notes: results.length > ctx.mutants ? [`Stryker tests every mutant (one build for all of them), so --mutants ${ctx.mutants} did not limit it.`] : [] };
    },
  };
}

interface Mull {
  runner: string;
  clang: string;
  clangxx: string;
  plugin: string;
}

/** mull-runner-N with clang-N and mull's compiler plugin for that LLVM version, if installed. */
function findMull(): Mull | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const version = /^mull-runner-(\d+)$/.exec(name)?.[1];
      if (version === undefined) continue;
      const onPath = (tool: string) => (process.env.PATH ?? '').split(delimiter).map((d) => join(d, tool)).find((p) => existsSync(p));
      const clang = onPath(`clang-${version}`);
      const clangxx = onPath(`clang++-${version}`);
      const plugin = [join(dirname(dir), 'lib', `mull-ir-frontend-${version}`), `/usr/lib/mull-ir-frontend-${version}`, `/usr/local/lib/mull-ir-frontend-${version}`].find((p) => existsSync(p));
      if (clang !== undefined && clangxx !== undefined && plugin !== undefined) return { runner: join(dir, name), clang, clangxx, plugin };
    }
  }
  return undefined;
}

/**
 * mull on a copy of the project: the candidate is built once with mull's clang plugin (through
 * CC/CXX and CFLAGS/CXXFLAGS, so the build command must use them), which compiles every mutant in;
 * mull-runner then switches each on by environment while `strength --check` runs. Every mutant is
 * tested; `--mutants` doesn't apply.
 */
async function mullTool(ctx: ToolContext, root: string, mull: Mull): Promise<Tool> {
  return {
    notes: [],
    async run() {
      if (ctx.build === undefined) throw new ConfigError('mull needs to rebuild the candidate: set candidate.build in port-anything.yaml.');
      const version = await run(mull.runner, ['--version'], { cwd: ctx.workDir });
      const tool = `mull ${/(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? version.stdout.trim().split('\n')[0]}`;
      const copy = join(ctx.workDir, 'mull');
      await copyProject(ctx, copy);
      const flags = `-O0 -g -grecord-command-line -fpass-plugin=${mull.plugin}`;
      const env = { ...process.env, CC: mull.clang, CXX: mull.clangxx, CFLAGS: flags, CXXFLAGS: flags };
      const built = await run('sh', ['-c', ctx.build!], { cwd: copy, env });
      if (built.code !== 0) throw new ConfigError(`Building the candidate with mull's clang plugin failed:\n${tail(built.stderr)}`);
      const exe = join(copy, relative(ctx.projectDir, (await resolveProgram(ctx.candidate, { cwd: ctx.projectDir })).path));
      const specPath = await writeSpec(ctx, { ...ctx.spec, project: copy, passNewEnv: true });
      const out = join(ctx.workDir, 'mull-out');
      const args = [
        `--workers=${ctx.jobs}`,
        `--timeout=${2 * ctx.caseTimeoutMs + 20_000}`,
        // Survivors are what the report is for, not an error.
        '--allow-surviving',
        '--reporters=Elements',
        `--report-dir=${out}`,
        '--report-name=strength',
        `--test-program=${ctx.node}`,
        exe,
        '--',
        ctx.cliEntry,
        'strength',
        '--check',
        specPath,
      ];
      const result = await run(mull.runner, args, { cwd: copy, env: checkEnv(ctx, specPath) });
      const report = join(out, 'strength.json');
      if (result.code !== 0 || !existsSync(report)) throw new ConfigError(`mull-runner exited ${result.code}:\n${tail(result.stdout)}\n${tail(result.stderr)}`);
      const results = parseElementsReport(JSON.parse(await readFile(report, 'utf8'))).map((r) => ({ ...r, name: r.name.startsWith(copy) ? relative(copy, r.name) : r.name }));
      const notes = results.length > ctx.mutants ? [`mull tests every mutant (one build for all of them), so --mutants ${ctx.mutants} did not limit it.`] : [];
      return { tool, generated: results.length, results, notes, why: 'the build must compile with $CC/$CXX and $CFLAGS/$CXXFLAGS for mull to see the source' };
    },
  };
}

/** Copies the project for mutating, without its git data and port-anything's own files. */
async function copyProject(ctx: ToolContext, copy: string): Promise<void> {
  await copyTree(ctx.projectDir, copy, [join(ctx.projectDir, '.git'), join(ctx.projectDir, '.port-anything')]);
}

/**
 * Copies a directory without the paths in `skip`. Entry by entry, since the copy is made inside
 * the project (under `.port-anything/tmp`) and `cp` refuses to copy a directory into itself.
 */
async function copyTree(from: string, to: string, skip: readonly string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const src = join(from, entry);
    if (skip.includes(src)) continue;
    await cp(src, join(to, entry), { recursive: true, verbatimSymlinks: true, filter: (path) => !skip.includes(path) });
  }
}

/**
 * The generic fallback: port-anything's own source mutator (operators, booleans, integers) on the
 * candidate's source files. Each worker has a copy of the project; per mutant it writes the mutated
 * file, rebuilds (`candidate.build`; a mutant that doesn't build is unviable) and runs the check in
 * this process. A candidate with no build step must be a script, which the check runs as mutated.
 */
async function genericTool(ctx: ToolContext, anchor: { path: string; script: boolean }, root: string, notes: string[]): Promise<Tool> {
  if (ctx.build === undefined && !anchor.script) {
    throw new ConfigError('The candidate has no build step and is not a script, so a mutated source would never run: set candidate.build in port-anything.yaml.');
  }
  return {
    notes,
    async run() {
      const files = await sourceFiles(ctx, root, anchor.path);
      const all: SourceMutant[] = [];
      const texts = new Map<string, string>();
      for (const file of files) {
        const text = await readFile(join(root, file), 'utf8');
        texts.set(file, text);
        all.push(...sourceMutants(file, text));
      }
      const tool = 'port-anything generic source mutator';
      if (all.length === 0) return { tool, generated: 0, results: [], notes: [], why: `no mutable source under ${display(ctx, root)}` };
      const byName = new Map(all.map((m) => [m.name, m]));
      const sample = sampleMutants(
        all.map((m) => m.name),
        ctx.mutants,
      ).map((name) => byName.get(name)!);

      const workers = Math.min(ctx.jobs, sample.length);
      const copies: string[] = [];
      let buildMs = 0;
      for (let k = 0; k < workers; k++) {
        const copy = join(ctx.workDir, `generic-${k}`);
        await copyProject(ctx, copy);
        if (ctx.build !== undefined) {
          const started = Date.now();
          const built = await run('sh', ['-c', ctx.build], { cwd: copy });
          if (built.code !== 0) throw new ConfigError(`The candidate's build failed in a copy of the project:\n${tail(built.stderr)}`);
          buildMs = Math.max(buildMs, Date.now() - started);
        }
        copies.push(copy);
      }
      const buildTimeoutMs = Math.max(300_000, 10 * buildMs);
      const relRoot = relative(ctx.projectDir, root);
      const results = await mapPool(sample, workers, async (mutant, _index, slot): Promise<MutantResult> => {
        const copy = copies[slot]!;
        const path = join(copy, relRoot, mutant.file);
        const original = texts.get(mutant.file)!;
        await writeFile(path, applyMutant(original, mutant));
        try {
          if (ctx.build !== undefined) {
            const built = await run('sh', ['-c', ctx.build], { cwd: copy, timeoutMs: buildTimeoutMs });
            if (built.code !== 0) return { name: mutant.name, status: 'unviable' };
          }
          const verdict = await ctx.check(ctx.spec, { project: copy });
          return { name: mutant.name, status: verdict.diverged === undefined ? 'missed' : 'caught' };
        } finally {
          await writeFile(path, original);
        }
      });
      return { tool, generated: all.length, results, notes: [] };
    },
  };
}

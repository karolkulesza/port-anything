import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readConfigFile } from '@port-anything/core';
import { afterAll, describe, expect, it } from 'vitest';

// The mutation ports of the wc-lite example: `port-anything strength` has cargo-mutants mutate the
// good port, and each mutant counts as caught when a case of the committed corpus diverges. The
// share caught (the corpus's mutation score) and the surviving mutants are checked against
// examples/wc-lite/mutation-score.json: the score must not drop and no new mutant may survive.
//
// Slow (one build and one corpus run per mutant), so it runs only with PA_MUTANTS set:
//   PA_MUTANTS=1       check against the recorded score
//   PA_MUTANTS=update  record the score and the survivors (then explain each new survivor's `why`)
// Needs a C compiler, cargo and cargo-mutants.
const exec = promisify(execFile);
const example = fileURLToPath(new URL('../../../examples/wc-lite/', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const scoreFile = join(example, 'mutation-score.json');
const mode = process.env.PA_MUTANTS;
const sandboxed = process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1';

/** The recorded result: the mutation tool, the counts, the score and every expected survivor. */
interface MutationScore {
  tool: string;
  mutants: number;
  caught: number;
  missed: number;
  timeout: number;
  unviable: number;
  /** caught / (caught + missed + timeout), to 4 decimals. */
  score: number;
  /** Mutants the corpus doesn't catch, each with why: equivalent (no behavior change) or what isn't tested. */
  survivors: { mutant: string; why: string }[];
  /** The mutants it catches, so that one no longer caught (or no longer generated) fails the check. */
  caught_mutants: string[];
}

const BAD_ATTRIBUTE = /^\s*#\[cfg\((any\()?feature = "bad-/;
const GOOD_ATTRIBUTE = /^\s*#\[cfg\(not\(feature = "bad-[a-z-]+"\)\)\]\s*$/;

/**
 * The good port's source without the bad ports' code: what the compiler sees with no feature on.
 * Blanks each item or block under `#[cfg(feature = "bad-…")]` (or `any(` of them), with the
 * comment lines just above it, and the attribute of those under `#[cfg(not(feature = "bad-…"))]`.
 * Otherwise cargo-mutants would also mutate code the good port doesn't contain, and every such
 * mutant would survive. Lines are blanked, not removed, so mutant names keep the source's lines.
 */
function stripBadPorts(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (GOOD_ATTRIBUTE.test(line)) {
      out.push('');
      continue;
    }
    if (!BAD_ATTRIBUTE.test(line)) {
      out.push(line);
      continue;
    }
    for (let k = out.length - 1; k >= 0 && /^\s*\/\//.test(out[k]!); k--) out[k] = '';
    out.push('');
    // The item: up to its matching closing brace when it opens one, else to the end of the statement.
    let depth = 0;
    for (i++; i < lines.length; i++) {
      const code = lines[i]!.replace(/\/\/.*$/, '');
      for (const ch of code) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      out.push('');
      if (depth === 0 && /[;}]\s*$/.test(code)) break;
    }
  }
  return out.join('\n');
}

/**
 * Why a result falls short of the recorded one: no mutant tested, fewer mutants, a recorded catch
 * no longer caught, new survivors, a lower score, or survivors left unexplained.
 */
function shortfalls(recorded: MutationScore, result: MutationScore): string[] {
  const known = new Set(recorded.survivors.map((s) => s.mutant));
  const caught = new Set(result.caught_mutants);
  return [
    ...(Number.isFinite(result.score) && result.caught + result.missed + result.timeout > 0 ? [] : ['no mutant was tested']),
    ...(result.mutants < recorded.mutants ? [`${result.mutants} mutants, fewer than the recorded ${recorded.mutants}`] : []),
    ...recorded.caught_mutants.filter((m) => !caught.has(m)).map((m) => `no longer caught: ${m}`),
    ...result.survivors.filter((s) => !known.has(s.mutant)).map((s) => `new survivor: ${s.mutant}`),
    ...(result.score < recorded.score ? [`score ${result.score} is below the recorded ${recorded.score}`] : []),
    ...recorded.survivors.filter((s) => s.why.trim() === '').map((s) => `no why for survivor: ${s.mutant}`),
  ];
}

describe('examples/wc-lite mutation harness', () => {
  it('strips exactly the bad ports from the source', () => {
    const source = readFileSync(join(example, 'port', 'src', 'main.rs'), 'utf8');
    const stripped = stripBadPorts(source);
    expect(stripped).not.toMatch(/bad-|Bug:/);
    expect(stripped).toContain('const USAGE_STATUS: i32 = 2;');
    expect(stripped).toContain('options_done = true;');
    // Lines are only blanked, so each keeps its number.
    const original = source.split('\n');
    const lines = stripped.split('\n');
    expect(lines).toHaveLength(original.length);
    for (const [i, line] of lines.entries()) expect([original[i], ''], `line ${i + 1}`).toContain(line);
  });

  it('fails a result with a new survivor, a lower score, a lost catch, fewer or no mutants, or an unexplained survivor, and passes one that only improves', () => {
    const recorded: MutationScore = JSON.parse(readFileSync(scoreFile, 'utf8'));
    expect(recorded.caught_mutants).toHaveLength(recorded.caught);
    const [first, ...rest] = recorded.survivors;
    expect(shortfalls(recorded, recorded)).toEqual([]);
    // One survivor fewer, caught now: better, so it passes.
    const better = { ...recorded, caught: recorded.caught + 1, missed: recorded.missed - 1, score: recorded.score + 0.01, survivors: rest, caught_mutants: [...recorded.caught_mutants, first!.mutant] };
    expect(shortfalls(recorded, better)).toEqual([]);
    const added = 'src/main.rs:1:1: replace x with y';
    const worse = { ...recorded, mutants: recorded.mutants + 1, score: recorded.score - 0.01, survivors: [...recorded.survivors, { mutant: added, why: '' }] };
    expect(shortfalls(recorded, worse)).toEqual([`new survivor: ${added}`, `score ${worse.score} is below the recorded ${recorded.score}`]);
    // A caught mutant that is no longer generated: the same score with one mutant fewer still fails.
    const [lost, ...kept] = recorded.caught_mutants;
    const fewer = { ...recorded, mutants: recorded.mutants - 1, caught: recorded.caught - 1, caught_mutants: kept };
    expect(shortfalls(recorded, fewer)).toEqual([`${fewer.mutants} mutants, fewer than the recorded ${recorded.mutants}`, `no longer caught: ${lost}`]);
    const nothing = { ...recorded, mutants: 0, caught: 0, missed: 0, timeout: 0, score: Number.NaN, survivors: [], caught_mutants: [] };
    expect(shortfalls(recorded, nothing)).toEqual(['no mutant was tested', `0 mutants, fewer than the recorded ${recorded.mutants}`, ...recorded.caught_mutants.map((m) => `no longer caught: ${m}`)]);
    expect(shortfalls({ ...recorded, survivors: [{ ...first!, why: ' ' }, ...rest] }, recorded)).toEqual([`no why for survivor: ${first!.mutant}`]);
  });
});

describe.runIf(mode !== undefined)('examples/wc-lite mutation score', () => {
  let root: string | undefined;
  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('catches at least the recorded share of cargo-mutants mutants, and no new one survives (done when)', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-wc-lite-mutants-')));
    const project = join(root, 'project');
    cpSync(example, project, {
      recursive: true,
      filter: (src) => {
        const path = relative(example, src).split(sep).join('/');
        return !['ref/wc-lite', 'port/target', '.port-anything'].some((p) => path === p || path.startsWith(`${p}/`));
      },
    });
    const config = await readConfigFile(project);
    await exec('sh', ['-c', config.reference.build!], { cwd: project });
    // A mutant that hangs times out on each case quickly instead of holding up the whole run.
    const yaml = join(project, 'port-anything.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^ {2}timeout: .*$/m, '  timeout: 2s'));
    const main = join(project, 'port', 'src', 'main.rs');
    writeFileSync(main, stripBadPorts(readFileSync(main, 'utf8')));
    await exec('sh', ['-c', config.candidate!.build!], { cwd: project });

    // Every mutant, however many there are: the record lists them all.
    const args = ['strength', '--json', '--mutants', '100000', ...(sandboxed ? [] : ['--no-sandbox'])];
    const { stdout } = await exec(process.execPath, [binPath, ...args], { cwd: project, maxBuffer: 64 * 1024 * 1024 }).catch((e: { code: number; stdout: string; stderr: string }) => {
      throw new Error(`port-anything strength exited ${e.code}\n${e.stdout}\n${e.stderr}`);
    });
    const strength = JSON.parse(stdout) as Omit<MutationScore, 'survivors'> & { survivors: string[] };
    const result: MutationScore = {
      tool: strength.tool,
      mutants: strength.mutants,
      caught: strength.caught,
      missed: strength.missed,
      timeout: strength.timeout,
      unviable: strength.unviable,
      score: strength.score ?? Number.NaN,
      survivors: strength.survivors.map((mutant) => ({ mutant, why: '' })),
      caught_mutants: strength.caught_mutants,
    };
    const counted = result.caught + result.missed + result.timeout;
    const summary = `wc-lite mutation score: ${(result.score * 100).toFixed(2)}% (${result.caught} of ${counted} mutants caught, ${result.unviable} unviable) with ${result.tool}`;
    console.log([summary, ...result.survivors.map((s) => `  survived: ${s.mutant}`)].join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n${result.survivors.map((s) => `- survived: \`${s.mutant}\``).join('\n')}\n`);
    }

    const recorded = existsSync(scoreFile) ? (JSON.parse(readFileSync(scoreFile, 'utf8')) as MutationScore) : undefined;
    if (mode === 'update') {
      const why = new Map(recorded?.survivors.map((s) => [s.mutant, s.why]));
      result.survivors = result.survivors.map((s) => ({ ...s, why: why.get(s.mutant) ?? '' }));
      writeFileSync(scoreFile, `${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    expect(recorded, `${scoreFile} is missing; record it with PA_MUTANTS=update`).toBeDefined();
    // A new survivor means the corpus misses it, or the port changed (then re-record with PA_MUTANTS=update).
    expect(shortfalls(recorded!, result)).toEqual([]);
  }, 3_600_000);
});

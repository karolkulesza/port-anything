import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { blobRef } from '../src/blob-store.js';
import { specFeatures, type CliSpec } from '../src/cli-spec.js';
import { generateCorpus, type ObserveReference } from '../src/corpus-generator.js';
import { cliSpecFromHelp, parseHelp } from '../src/help-parser.js';
import { canonicalObservation } from '../src/model.js';

// What `compare` generates for the references of the README quickstarts: BSD sort on macOS, GNU
// sort on Linux (and Homebrew's gsort, the dev container's gnusort). The help texts
// are captured here, at test time, and never committed (GNU's is GPL). The reference runs without
// a sandbox: sort is harmless and every generated path is relative to a scratch directory.

const isGnu = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU coreutils') === true;

/** The quickstart sorts this machine has, by the command that runs them. */
const SORTS = [
  ...(process.platform === 'darwin' ? ['/usr/bin/sort', 'gsort'] : []),
  // On Ubuntu 25.10 and later /usr/bin/sort is uutils, which the quickstart uses as the candidate.
  ...(process.platform === 'linux' ? ['/usr/bin/sort', 'gnusort'].filter(isGnu) : []),
].filter((cmd) => spawnSync(cmd, ['--help'], { stdio: 'ignore' }).error === undefined);

/** Same seed and budget as `compare`. */
const SEED = 42;
const BUDGET = 500;

function helpOf(cmd: string): string {
  const result = spawnSync(cmd, ['--help'], { encoding: 'utf8', argv0: 'sort', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', COLUMNS: '80' } });
  return result.stdout.trim() !== '' ? result.stdout : result.stderr;
}

function specOf(cmd: string): CliSpec {
  return cliSpecFromHelp('sort', parseHelp(helpOf(cmd), { program: 'sort' }));
}

const scratch = mkdtempSync(join(tmpdir(), 'pa-generator-coverage-'));

/** Runs `cmd` as `sort` on each case, in a fresh directory holding the case's fixtures. */
function observer(cmd: string): ObserveReference {
  let n = 0;
  return async (cases, blobs) =>
    cases.map((c) => {
      const dir = join(scratch, String(n++));
      mkdirSync(dir);
      for (const [path, ref] of Object.entries(c.fixtures)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), blobs.get(ref)!);
      }
      const result = spawnSync(cmd, c.argv, {
        cwd: dir,
        argv0: 'sort',
        input: c.stdin === null ? '' : blobs.get(c.stdin)!,
        env: { PATH: process.env.PATH, LC_ALL: 'C' },
        timeout: 10_000,
      });
      rmSync(dir, { recursive: true, force: true });
      return canonicalObservation({
        // Killed (by the timeout or otherwise): a signal and no exit code.
        exit: result.signal === null ? result.status : null,
        signal: result.signal,
        timeout: result.error !== undefined,
        stdout: blobRef(result.stdout ?? new Uint8Array()),
        stderr: blobRef(result.stderr ?? new Uint8Array()),
        fs: { created: {}, modified: {}, deleted: [] },
        time_ms: { wall: 1, user: null, sys: null },
        rss_kb: null,
        runs: 1,
        stable: true,
      });
    });
}

const featureOf = (spec: CliSpec, name: string): string => {
  const flag = spec.flags.find((f) => f.names.includes(name));
  if (!flag) throw new Error(`no ${name} in ${JSON.stringify(spec.flags.map((f) => f.names))}`);
  return flag.feature;
};

describe.runIf(SORTS.length > 0)('generator coverage of the quickstart sorts', () => {
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.each(SORTS)('%s: -k, -n and -r each keep cases the reference accepts', { timeout: 180_000 }, async (cmd) => {
    const spec = specOf(cmd);
    const corpus = await generateCorpus(spec, { seed: SEED, generator: 'v1', budget: BUDGET, observe: observer(cmd) });
    const tested = new Set(corpus.cases.flatMap((c) => c.case.features));
    const accepted = new Set(corpus.cases.filter((c) => c.observation.exit === 0).flatMap((c) => c.case.features));
    for (const name of ['-k', '-n', '-r']) {
      const feature = featureOf(spec, name);
      expect(tested, `${name} (${feature}) untested`).toContain(feature);
      expect(accepted, `${name} (${feature}) never accepted`).toContain(feature);
    }
    // A few flags may fail on nearly every generated case (`--check` on unsorted input) and stay
    // untested under the error-path cap; a misread help text leaves far more (it was about half).
    const features = specFeatures(spec).filter((f) => !f.selfDescription);
    const untested = features.filter((f) => !tested.has(f.name)).map((f) => f.name);
    expect(untested.length, `untested: ${untested.join(', ')}`).toBeLessThanOrEqual(Math.floor(features.length / 4));
  });
});

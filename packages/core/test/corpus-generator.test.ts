import { describe, expect, it } from 'vitest';
import { generateArgvCases } from '../src/argv-generator.js';
import { blobRef } from '../src/blob-store.js';
import { parseCliSpec, type CliSpec } from '../src/cli-spec.js';
import {
  DEDUP_SAMPLE,
  generateCorpus,
  isErrorObservation,
  type CorpusCase,
  type GenerateCorpusOptions,
  type ObserveReference,
} from '../src/corpus-generator.js';
import { canonicalObservation, type CanonicalCase, type Observation } from '../src/model.js';

const frob: CliSpec = parseCliSpec({
  version: 1,
  program: 'frob',
  flags: [
    { names: ['-n', '--numeric'], feature: 'opt.numeric', arity: 0 },
    { names: ['-r', '--reverse'], feature: 'opt.reverse', arity: 0 },
    { names: ['-u'], feature: 'opt.u', arity: 0 },
    { names: ['-k', '--key'], feature: 'opt.key', arity: 1, values: [{ name: 'N', type: 'int' }] },
    { names: ['-o', '--output'], feature: 'opt.output', arity: 1, values: [{ name: 'FILE', type: 'path' }] },
    { names: ['--sort'], feature: 'opt.sort', arity: 1, values: [{ name: 'WORD', type: 'enum', choices: ['numeric', 'month'] }] },
    { names: ['--help'], feature: 'opt.help', arity: 0, self_description: true },
  ],
  forms: [{ usage: 'frob [OPTION]... [FILE]...', args: [{ name: 'FILE', type: 'path', arity: '*' }] }],
});

// Each test generates hundreds to thousands of cases; leave room for a loaded machine.
const SLOW = 30_000;

const decoder = new TextDecoder();

function observation(exit: number, stdout: string, stderr = ''): Observation {
  return canonicalObservation({
    exit,
    signal: null,
    timeout: false,
    stdout: blobRef(stdout),
    stderr: blobRef(stderr),
    fs: { created: {}, modified: {}, deleted: [] },
    time_ms: { wall: 1, user: null, sys: null },
    rss_kb: null,
    runs: 1,
    stable: true,
  });
}

/** Everything a case gives the program, as text: argv, stdin and every fixture. */
function inputs(c: CanonicalCase, blobs: ReadonlyMap<string, Uint8Array>): string {
  const content = (ref: string) => decoder.decode(blobs.get(ref)!);
  const files = Object.entries(c.fixtures).map(([path, ref]) => `${path}=${content(ref)}`);
  return JSON.stringify([c.argv, c.stdin === null ? null : content(c.stdin), files]);
}

/** A reference whose output (or error message) depends on all of its input; `fails` decides which cases exit 1. */
function reference(fails: (c: CanonicalCase) => boolean = () => false): ObserveReference & { calls: number; cases: number } {
  const observe = async (cases: readonly CanonicalCase[], blobs: ReadonlyMap<string, Uint8Array>) => {
    observe.calls++;
    observe.cases += cases.length;
    return cases.map((c) => (fails(c) ? observation(1, '', `frob: ${inputs(c, blobs)}`) : observation(0, inputs(c, blobs))));
  };
  observe.calls = 0;
  observe.cases = 0;
  return observe;
}

const options = (extra: Partial<GenerateCorpusOptions> = {}): GenerateCorpusOptions => ({
  seed: 1,
  generator: 'v1',
  observe: reference(),
  budget: 300,
  ...extra,
});

/** Kept cases per feature, and how many of them are error exits; `*` is the whole corpus. */
function tally(cases: readonly CorpusCase[]): Map<string, { total: number; errors: number }> {
  const out = new Map<string, { total: number; errors: number }>();
  for (const c of cases) {
    for (const g of [...c.case.features, '*']) {
      const t = out.get(g) ?? { total: 0, errors: 0 };
      t.total++;
      if (isErrorObservation(c.observation)) t.errors++;
      out.set(g, t);
    }
  }
  return out;
}

describe('generateCorpus: byte mutation', { timeout: SLOW }, () => {
  it('derives mutants that keep the parent argv and features and change one input', async () => {
    const corpus = await generateCorpus(frob, options());
    const argvCases = corpus.cases.filter((c) => c.strategy !== 'mutation');
    const mutants = corpus.cases.filter((c) => c.strategy === 'mutation');
    expect(mutants.length).toBeGreaterThan(0);
    for (const m of mutants) {
      expect(m.case.origin).toBe('generated');
      const parent = argvCases.find(
        (p) => JSON.stringify(p.case.argv) === JSON.stringify(m.case.argv) && JSON.stringify(p.case.features) === JSON.stringify(m.case.features),
      );
      expect(parent, JSON.stringify(m.case.argv)).toBeDefined();
      expect(Object.keys(m.case.fixtures).sort()).toEqual(Object.keys(parent!.case.fixtures).sort());
      const changed = [m.case.stdin !== parent!.case.stdin, ...Object.keys(m.case.fixtures).map((p) => m.case.fixtures[p] !== parent!.case.fixtures[p])];
      expect(changed.filter(Boolean).length).toBeLessThanOrEqual(1);
      for (const ref of [m.case.stdin, ...Object.values(m.case.fixtures)]) if (ref !== null) expect(corpus.blobs.has(ref)).toBe(true);
    }
  });

  it('mutates the seed fixtures in place of a case input', async () => {
    const seed = 'SEED-FIXTURE-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789\n';
    const corpus = await generateCorpus(frob, options({ seeds: [new TextEncoder().encode(seed)] }));
    const contents = corpus.cases
      .filter((c) => c.strategy === 'mutation')
      .flatMap((c) => [c.case.stdin, ...Object.values(c.case.fixtures)])
      .filter((ref) => ref !== null)
      .map((ref) => decoder.decode(corpus.blobs.get(ref)));
    expect(contents.some((text) => text.includes(seed.slice(0, 20)) || text.includes(seed.slice(-21)))).toBe(true);
  });

  it('is deterministic for the seed and generator version', async () => {
    const ids = async (seed: number) => (await generateCorpus(frob, options({ seed, observe: reference() }))).cases.map((c) => c.case.id);
    const first = await ids(1);
    expect(await ids(1)).toEqual(first);
    expect(await ids(2)).not.toEqual(first);
  });
});

describe('generateCorpus: dedup by observation', { timeout: SLOW }, () => {
  it(`keeps ${DEDUP_SAMPLE} cases per reference behavior and feature set`, async () => {
    // Output depends on the flags only, so every input mutant behaves like its parent.
    const observe: ObserveReference = async (cases) => cases.map((c) => observation(0, c.features.join(',')));
    const corpus = await generateCorpus(frob, options({ observe }));
    const perBehavior = new Map<string, number>();
    for (const c of corpus.cases) {
      const key = `${c.observation.stdout} ${c.case.features.join(',')}`;
      perBehavior.set(key, (perBehavior.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perBehavior.values())).toBe(DEDUP_SAMPLE);
    expect(corpus.stats.dropped.duplicate).toBeGreaterThan(0);
    expect(corpus.stats.stop).toBe('exhausted');
  });

  it('keeps cases with the same behavior when they hit different features', async () => {
    const observe: ObserveReference = async (cases) => cases.map(() => observation(0, 'same\n'));
    const corpus = await generateCorpus(frob, options({ observe }));
    const kept = new Map<string, number>();
    for (const c of corpus.cases) kept.set(c.case.features.join(','), (kept.get(c.case.features.join(',')) ?? 0) + 1);
    const generated = new Set(generateArgvCases(frob, { seed: 1, generator: 'v1' }).cases.map((c) => c.case.features.join(',')));
    expect([...kept.keys()].sort()).toEqual([...generated].sort());
    expect(Math.max(...kept.values())).toBeLessThanOrEqual(DEDUP_SAMPLE);
  });
});

describe('generateCorpus: --budget', { timeout: SLOW }, () => {
  it('caps the case count and spreads a small budget over every feature', async () => {
    const observe = reference();
    const corpus = await generateCorpus(frob, options({ budget: 20, observe }));
    expect(corpus.cases).toHaveLength(20);
    expect(corpus.stats.stop).toBe('budget');
    const features = new Set(corpus.cases.flatMap((c) => c.case.features));
    for (const f of ['base', 'opt.numeric', 'opt.reverse', 'opt.u', 'opt.key', 'opt.output', 'opt.sort', 'opt.help']) expect(features).toContain(f);
    expect(observe.cases).toBeLessThanOrEqual(32);
  });

  it('runs nothing with a budget of 0', async () => {
    const observe = reference();
    const corpus = await generateCorpus(frob, options({ budget: 0, observe }));
    expect(corpus.cases).toEqual([]);
    expect(observe.calls).toBe(0);
  });

  it('fills up to the budget with mutants', async () => {
    const corpus = await generateCorpus(frob, options({ budget: 500 }));
    expect(corpus.cases).toHaveLength(500);
    expect(corpus.stats.stop).toBe('budget');
  });
});

describe('generateCorpus: --time', { timeout: SLOW }, () => {
  it('starts no batch once the time cap is reached', async () => {
    let clock = 0;
    const inner = reference();
    const observe: ObserveReference = async (cases, blobs) => {
      clock += 1000;
      return inner(cases, blobs);
    };
    const corpus = await generateCorpus(frob, options({ budget: 10_000, timeMs: 2500, now: () => clock, observe }));
    expect(inner.calls).toBe(3);
    expect(corpus.stats.stop).toBe('time');
    expect(corpus.cases.length).toBe(corpus.stats.observed);
  });
});

describe('generateCorpus: error-path cap', { timeout: SLOW }, () => {
  // 70% of the cases (by ID) error on this reference, and every call with an invalid value does.
  const errorHeavy = (c: CanonicalCase) => parseInt(c.id.slice(-4), 16) % 10 < 7 || c.argv.some((a) => /abc|1\.5|invalid|--no-such/.test(a));

  it('keeps an error-path-heavy spec under the cap in every feature and overall', async () => {
    const corpus = await generateCorpus(frob, options({ budget: 1000, observe: reference(errorHeavy) }));
    const counts = tally(corpus.cases);
    for (const [group, { total, errors }] of counts) expect(errors / total, group).toBeLessThanOrEqual(0.3);
    expect(counts.get('*')!.errors / counts.get('*')!.total).toBeGreaterThan(0.2);
    expect(corpus.stats.dropped.errorCap).toBeGreaterThan(0);
  });

  it('keeps no case of a feature whose every call errors, and reports it under-sampled', async () => {
    const corpus = await generateCorpus(frob, options({ observe: reference((c) => c.features.includes('opt.reverse')) }));
    expect(corpus.cases.some((c) => c.case.features.includes('opt.reverse'))).toBe(false);
    expect(corpus.stats.underSampled).toContainEqual({ feature: 'opt.reverse', cases: 0 });
  });

  it('applies a configured cap, down to no error cases at all', async () => {
    for (const cap of [0.1, 0]) {
      const corpus = await generateCorpus(frob, options({ errorPathCap: cap, observe: reference(errorHeavy) }));
      for (const [group, { total, errors }] of tally(corpus.cases)) expect(errors / total, `${cap} ${group}`).toBeLessThanOrEqual(cap);
    }
  });

  it('counts untagged cases against the whole corpus', async () => {
    // Only the unknown-flag calls fail; they carry no feature.
    const corpus = await generateCorpus(frob, options({ observe: reference((c) => c.features.length === 0) }));
    const untagged = corpus.cases.filter((c) => c.case.features.length === 0);
    expect(untagged.length).toBeGreaterThan(0);
    expect(untagged.every((c) => isErrorObservation(c.observation))).toBe(true);
  });
});

describe('generateCorpus: minimum cases per feature', { timeout: SLOW }, () => {
  it('tops every feature up to the minimum before filling the rest', async () => {
    const argvCount = generateArgvCases(frob, { seed: 1, generator: 'v1' }).cases.length;
    // Room for the argv cases plus the top-up only.
    const corpus = await generateCorpus(frob, options({ budget: 200 }));
    const counts = tally(corpus.cases);
    for (const f of ['base', 'opt.numeric', 'opt.reverse', 'opt.u', 'opt.key', 'opt.output', 'opt.sort']) {
      expect(counts.get(f)?.total ?? 0, f).toBeGreaterThanOrEqual(20);
    }
    expect(corpus.stats.underSampled).toEqual([]);
    expect(argvCount).toBeLessThan(200);
  });

  it('does not top up self-description features', async () => {
    const corpus = await generateCorpus(frob, options({ budget: 2000 }));
    const help = corpus.cases.filter((c) => c.case.features.includes('opt.help'));
    expect(help.every((c) => c.strategy !== 'mutation')).toBe(true);
    expect(corpus.stats.underSampled.map((f) => f.feature)).not.toContain('opt.help');
  });

  it('reports the features it could not top up', async () => {
    // -u ignores its input: its mutants are all duplicates.
    const observe: ObserveReference = async (cases, blobs) =>
      cases.map((c) => observation(0, c.features.includes('opt.u') ? 'u\n' : inputs(c, blobs)));
    const corpus = await generateCorpus(frob, options({ budget: 2000, observe }));
    expect(corpus.stats.underSampled).toEqual([{ feature: 'opt.u', cases: tally(corpus.cases).get('opt.u')!.total }]);
    expect(corpus.stats.underSampled[0]!.cases).toBeLessThan(20);
  });
});

describe('generateCorpus: options', { timeout: SLOW }, () => {
  it('rejects out-of-range options', async () => {
    await expect(generateCorpus(frob, options({ budget: -1 }))).rejects.toThrow(RangeError);
    await expect(generateCorpus(frob, options({ errorPathCap: 1.5 }))).rejects.toThrow(RangeError);
    await expect(generateCorpus(frob, options({ minCasesPerFeature: 2.5 }))).rejects.toThrow(RangeError);
    await expect(generateCorpus(frob, options({ timeMs: 0 }))).rejects.toThrow(RangeError);
  });

  it('refuses an observe that loses cases', async () => {
    await expect(generateCorpus(frob, options({ observe: async () => [] }))).rejects.toThrow(/observations/);
  });
});

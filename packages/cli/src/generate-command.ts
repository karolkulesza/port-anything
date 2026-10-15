import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_BUDGET,
  DEFAULT_GENERATOR,
  DEFAULT_GENERATOR_SEED,
  GENERATED_CORPUS_FILE,
  SandboxUnavailableError,
  generatedCorpusSettings,
  parseConfigSource,
  setCorpusSettings,
  specFeatures,
  type SandboxProbe,
} from '@port-anything/core';
import { display, type CliResult } from './common.js';
import { generateProjectCorpus } from './corpus.js';

/** The options of `port-anything generate`. */
export interface GenerateArgs {
  /** `--budget N`: sets `corpus.budget`. */
  budget?: number;
  /** `--seed S`: sets `corpus.generator_seed`. */
  seed?: number;
  noSandbox: boolean;
}

export const USAGE = 'Usage: port-anything generate [--budget N] [--seed S] [--no-sandbox]';

/** Reads the arguments after `generate`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseGenerateArgs(argv: readonly string[]): GenerateArgs {
  if (argv.some((arg) => arg === '--time' || arg.startsWith('--time='))) {
    throw new ConfigError("--time is not available yet in this version of port-anything generate: a time cap would make the cases depend on the machine's speed, so a checkout could not regenerate them.");
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { budget: { type: 'string' }, seed: { type: 'string' }, 'no-sandbox': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
  const whole = (name: string, value: string, min: number) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) throw new ConfigError(`--${name} must be a whole number of at least ${min}, got "${value}".`);
    return n;
  };
  return {
    ...(values.budget === undefined ? {} : { budget: whole('budget', values.budget, 1) }),
    ...(values.seed === undefined ? {} : { seed: whole('seed', values.seed, 0) }),
    noSandbox: values['no-sandbox'] ?? false,
  };
}

/**
 * `port-anything generate`: generates the project's corpus from `port-anything/cli-spec.yaml` and
 * the seed fixtures, running the reference to filter the cases, and caches it in
 * `.port-anything/cache/`. `--budget` and `--seed` are written to `port-anything.yaml`
 * (`corpus.budget`, `corpus.generator_seed`), as are the generator and seed in use when the config
 * has none, since every checkout regenerates the same cases from them: `run`, `baseline`,
 * `minimize` and `strength` regenerate when the cache is missing. Exit code 0 when the corpus was
 * generated, 3 when it can't be (config, spec, programs, sandbox).
 */
export async function generateCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  try {
    return await execute(parseGenerateArgs(argv), options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything generate: ${message}\n` });

async function execute(args: GenerateArgs, options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  const file = join(options.cwd, CONFIG_FILE);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`No ${CONFIG_FILE} in ${options.cwd}.`);
    throw new ConfigError(`Cannot read ${CONFIG_FILE}: ${(e as Error).message}`);
  }
  const before = parseConfigSource(source);
  const edited = setCorpusSettings(source, {
    generator: before.corpus?.generator ?? DEFAULT_GENERATOR,
    generator_seed: args.seed ?? before.corpus?.generator_seed ?? DEFAULT_GENERATOR_SEED,
    ...(args.budget !== undefined ? { budget: args.budget } : before.corpus?.budget === undefined ? { budget: DEFAULT_BUDGET } : {}),
  });
  const config = parseConfigSource(edited); // never leave a config that no longer loads
  const settings = generatedCorpusSettings(config)!;

  const generated = await generateProjectCorpus(options.cwd, config, settings, { noSandbox: args.noSandbox, force: true, ...(options.probe === undefined ? {} : { probe: options.probe }) });
  if (edited !== source) await writeFile(file, edited);

  const { corpus, spec } = generated;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const { dropped } = corpus.stats;
  const untested = specFeatures(spec)
    .map((f) => f.name)
    .filter((name) => !corpus.cases.some((c) => c.features.includes(name)));
  const lines = [
    `Generated ${plural(corpus.cases.length, 'case')} (budget ${settings.budget}, generator ${settings.generator}, seed ${settings.seed}) as "${generated.programName}", sandbox: ${generated.sandbox!.label}`,
    `reference ${display(config.reference.cmd)}`,
    `the reference ran ${plural(corpus.stats.observed, 'case')}; left out: ${dropped.duplicate} duplicate, ${dropped.errorCap} over the error-path cap, ${dropped.budget} over the budget`,
  ];
  if (corpus.skipped.length > 0) lines.push(`left out as destructive: ${corpus.skipped.join(', ')}`);
  if (corpus.stats.underSampled.length > 0) {
    lines.push(`under-sampled (fewer than ${settings.minCasesPerFeature} cases): ${corpus.stats.underSampled.map((f) => `${f.feature} ${f.cases}`).join(', ')}`);
  }
  if (untested.length > 0) lines.push(`untested (no generated case): ${untested.join(', ')}`);
  if (edited !== source) lines.push(`set corpus.generator, corpus.generator_seed and corpus.budget in ${CONFIG_FILE}`);
  lines.push(`cached in .port-anything/cache/${GENERATED_CORPUS_FILE}; without it, run and baseline regenerate the same cases from ${CONFIG_FILE} and the CLI spec`);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

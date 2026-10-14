import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { generateArgvCases, isSafeArgvToken } from '../src/argv-generator.js';
import { DestructiveToolError } from '../src/destructive.js';
import { cliSpecFromHelp, parseHelp } from '../src/help-parser.js';

// The generator on specs parsed from real tools' help in the dev container. The help texts are
// captured at test time and never committed (many are GPL). Run with: scripts/dev-linux.sh pnpm -r test

const TOOLS: [program: string, argv: string[]][] = [
  ['gnusort', ['gnusort', '--help']],
  ['gnuls', ['gnuls', '--help']],
  ['gnudate', ['gnudate', '--help']],
  ['gnucut', ['gnucut', '--help']],
  ['gnuod', ['gnuod', '--help']],
  ['grep', ['grep', '--help']],
  ['sed', ['sed', '--help']],
  ['tar', ['tar', '--help']],
  ['jq', ['jq', '--help']],
  ['jaq', ['jaq', '--help']],
  ['git', ['git', '--help']],
  ['curl', ['curl', '--help']],
  ['find', ['find', '--help']],
  ['sort', ['busybox', 'sort', '--help']],
];

function specOf(program: string, argv: string[]) {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', COLUMNS: '80' } });
  if (result.error) throw result.error;
  const text = result.stdout.trim() !== '' ? result.stdout : result.stderr;
  return cliSpecFromHelp(program, parseHelp(text, { program }));
}

describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('generateArgvCases on real tools (Linux)', () => {
  it.each(TOOLS)('%s: relative in-sandbox paths only, same cases for the same seed', (program, argv) => {
    const spec = specOf(program, argv);
    const out = generateArgvCases(spec, { seed: 42, generator: 'v1' });
    expect(out.cases.length).toBeGreaterThan(spec.flags.length);
    for (const { case: c } of out.cases) {
      for (const token of c.argv) {
        expect(token.startsWith('/') || token.split('/').includes('..'), JSON.stringify(c.argv)).toBe(false);
        expect(isSafeArgvToken(token)).toBe(true);
      }
    }
    const again = generateArgvCases(specOf(program, argv), { seed: 42, generator: 'v1' });
    expect(again.cases.map((c) => c.case.id)).toEqual(out.cases.map((c) => c.case.id));
  });

  it('refuses rm and shred parsed from their real help without iKnow', () => {
    for (const tool of ['gnurm', 'gnushred']) {
      const spec = specOf(tool.slice(3), [tool, '--help']);
      expect(() => generateArgvCases(spec, { seed: 1, generator: 'v1' })).toThrow(DestructiveToolError);
      expect(generateArgvCases(spec, { seed: 1, generator: 'v1', iKnow: true }).cases.length).toBeGreaterThan(0);
    }
  });
});

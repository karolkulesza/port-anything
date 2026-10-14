import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPARED_FIELDS, type SandboxProbe } from '@port-anything/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCommand, parseCompareArgs, type CompareSummary } from '../src/compare-command.js';

// The port-audit skill drives `compare --json`, so what it tells an agent about the command and the
// JSON must stay true as the CLI changes. Needs @port-anything/core built, like the other CLI tests.
const SKILL = readFileSync(new URL('../../../skills/port-audit/SKILL.md', import.meta.url), 'utf8');

// `bad` ignores --upper, so the run has divergences to describe.
const TOOL = (bad: boolean) => `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -u, --upper     upper-case the output\\n      --help      display this help and exit\\n'
  exit 0
fi
upper=
while [ $# -gt 0 ]; do
  case "$1" in
    -u|--upper) upper=${bad ? '' : '1'} ;;
    --) shift; break ;;
    -?*) echo "frob: unrecognized option '$1'" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
cat "$@" | if [ -n "$upper" ]; then tr 'a-z' 'A-Z'; else cat; fi
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

/** The words of a shell command line, with '…' and "…" quoting (enough for the skill's examples). */
function shellWords(line: string): string[] {
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/** Every key path in a JSON value, `[]` standing for any element of an array. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...keyPaths(v, path)];
  });
}

/** The values at a path such as `candidates[].per_feature[].parity`; `[]` steps into every element. */
function valuesAt(value: unknown, path: string): unknown[] {
  let values = [value];
  for (const part of path.split('.')) {
    const key = part.replace(/\[\]$/, '');
    values = values.flatMap((v) => (v !== null && typeof v === 'object' && key in v ? [(v as Record<string, unknown>)[key]] : []));
    if (part.endsWith('[]')) values = values.flatMap((v) => (Array.isArray(v) ? v : []));
  }
  return values;
}

describe('the port-audit skill', () => {
  it('has the frontmatter a skill needs', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)?.[1];
    expect(front).toBeDefined();
    expect(front).toMatch(/^name: port-audit$/m);
    expect(front).toMatch(/^description: \S.{40,}$/m);
  });

  it('shows only compare invocations the CLI accepts', () => {
    const commands = [...SKILL.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n')).filter((l) => /^(npx )?port-anything compare /.test(l));
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands) {
      const words = shellWords(line.replace(/\s+>\s.*$/, ''));
      const args = words.slice(words.indexOf('compare') + 1);
      expect(() => parseCompareArgs(args), line).not.toThrow();
    }
    // Options it mentions on their own, outside a full command line.
    for (const option of new Set([...SKILL.matchAll(/`(--[a-z-]+)(?: \w+)?`/g)].map((m) => m[1]!))) {
      if (option === '--help' || option === '--version') continue; // the audited programs' options
      const args = option === '--budget' ? ['a', 'b', option, '10'] : ['a', 'b', option];
      expect(() => parseCompareArgs(args), option).not.toThrow();
    }
  });

  it('names the divergence fields compare reports', () => {
    const row = SKILL.split('\n').find((l) => l.startsWith('| `candidates[].divergences[]`'))!;
    for (const field of COMPARED_FIELDS) expect(row).toContain(`\`${field}\``);
  });

  describe('describes fields the JSON has', { timeout: 120_000 }, () => {
    let dir: string;
    let summary: CompareSummary;
    beforeAll(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-audit-skill-')));
      mkdirSync(join(dir, 'scratch'));
      writeFileSync(join(dir, 'frob'), TOOL(false), { mode: 0o755 });
      writeFileSync(join(dir, 'frob-bad'), TOOL(true), { mode: 0o755 });
      const result = await compareCommand(['./frob', './frob-bad', '--budget', '40', '--json', '--no-sandbox'], { cwd: dir, probe: NO_SANDBOX, tmpDir: join(dir, 'scratch'), concurrency: 2 });
      expect(result.exitCode).toBe(1);
      summary = JSON.parse(result.stdout) as CompareSummary;
    }, 120_000);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('in the field table', () => {
      const table = SKILL.split('\n').filter((l) => /^\| `/.test(l));
      const paths = table.flatMap((l) => [...l.split('|')[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
      expect(paths.length).toBeGreaterThan(15);
      expect(summary.candidates[0]!.divergences.length).toBeGreaterThan(0);
      for (const path of paths) expect(valuesAt(summary, path), path).not.toEqual([]);
      // And the other way: every key the JSON has is in the table, itself, within a row it names
      // (`corpus.dropped` covers its counts) or as the parent of named keys (`spec`).
      const covered = (path: string) => paths.some((p) => path === p || path.startsWith(`${p}.`) || p.startsWith(`${path}.`) || p.startsWith(`${path}[]`));
      for (const path of new Set(keyPaths(summary))) expect(covered(path), path).toBe(true);
    });

    it('in the keys it names inside a row', () => {
      const keys = { 'candidates[].per_feature[]': ['feature', 'match', 'cases', 'parity'], 'candidates[].divergences[]': ['case', 'argv', 'fields'], 'baseline.flaky_reference': ['case', 'argv', 'fields'] };
      for (const [path, names] of Object.entries(keys)) {
        const row = SKILL.split('\n').find((l) => l.startsWith(`| \`${path}\``))!;
        for (const name of names) {
          expect(row, path).toContain(`\`${name}\``);
          if (path !== 'baseline.flaky_reference') expect(valuesAt(summary, `${path}.${name}`), `${path}.${name}`).not.toEqual([]);
        }
      }
    });
  });
});

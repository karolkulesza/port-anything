import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { CLI_SPEC_FILE, cliSpecYaml, parseCliSpec, readCliSpecFile, specFeatures, type CliSpec } from '../src/cli-spec.js';
import { ConfigError } from '../src/config.js';

const SPEC = {
  version: 1,
  program: 'frob',
  flags: [
    { names: ['-n', '--count'], feature: 'opt.count', description: 'stop after N lines', arity: 1, values: [{ name: 'N', type: 'int' }] },
    { names: ['--color'], feature: 'opt.color', arity: 1, values: [{ name: 'WHEN', type: 'enum', choices: ['always', 'never'], optional: true }] },
    { names: ['-q'], feature: 'opt.q', arity: 0 },
    { names: ['--help'], feature: 'opt.help', arity: 0, self_description: true },
  ],
  forms: [{ usage: 'frob [OPTION]... [FILE]...', args: [{ name: 'FILE', type: 'path', arity: '*' }] }],
  subcommands: [{ name: 'make', feature: 'cmd.make', flags: [{ names: ['-f'], feature: 'cmd.make.opt.f', arity: 0 }] }],
};

describe('parseCliSpec', () => {
  it('fills in the defaults', () => {
    const spec = parseCliSpec(SPEC);
    expect(spec.flags[2]).toEqual({ names: ['-q'], feature: 'opt.q', arity: 0, values: [] });
    expect(spec.forms[0]!.flags).toEqual([]);
    expect(spec.subcommands[0]).toEqual({
      name: 'make',
      feature: 'cmd.make',
      flags: [{ names: ['-f'], feature: 'cmd.make.opt.f', arity: 0, values: [] }],
      forms: [],
      subcommands: [],
    });
  });

  it('lists every feature, self-description ones marked', () => {
    expect(specFeatures(parseCliSpec(SPEC))).toEqual([
      { name: 'opt.count', selfDescription: false },
      { name: 'opt.color', selfDescription: false },
      { name: 'opt.q', selfDescription: false },
      { name: 'opt.help', selfDescription: true },
      { name: 'cmd.make', selfDescription: false },
      { name: 'cmd.make.opt.f', selfDescription: false },
    ]);
  });

  it.each([
    ['an arity that disagrees with the values', { flags: [{ names: ['-n'], feature: 'opt.n', arity: 2, values: [{ name: 'N', type: 'int' }] }] }, 'flags.0.arity'],
    ['a flag name with a space', { flags: [{ names: ['-n x'], feature: 'opt.n', arity: 0 }] }, 'flags.0.names.0'],
    ['enum without choices', { flags: [{ names: ['-n'], feature: 'opt.n', arity: 1, values: [{ name: 'N', type: 'enum' }] }] }, 'flags.0.values.0'],
    ['an optional value on a two-value flag', { flags: [{ names: ['-n'], feature: 'opt.n', arity: 2, values: [{ name: 'A', type: 'string', optional: true }, { name: 'B', type: 'string' }] }] }, 'flags.0.values'],
    ['a duplicate feature', { flags: [{ names: ['-a'], feature: 'opt.x', arity: 0 }, { names: ['-b'], feature: 'opt.x', arity: 0 }] }, 'opt.x is defined more than once'],
    ['an unknown key', { flagz: [] }, 'flagz'],
    ['an unknown positional arity', { forms: [{ usage: 'x', args: [{ name: 'A', type: 'string', arity: '2' }] }] }, 'forms.0.args.0.arity'],
  ])('rejects %s, naming the key', (_, change, where) => {
    expect(() => parseCliSpec({ version: 1, program: 'frob', ...change })).toThrow(ConfigError);
    expect(() => parseCliSpec({ version: 1, program: 'frob', ...change })).toThrow(where);
  });
});

describe('cliSpecYaml', () => {
  it('writes YAML that reads back to the same spec, without empty lists', () => {
    const spec: CliSpec = parseCliSpec(SPEC);
    const yaml = cliSpecYaml(spec);
    expect(parseCliSpec(parseDocument(yaml).toJS())).toEqual(spec);
    expect(yaml).toContain('names: [ -n, --count ]');
    expect(yaml).toContain('choices: [ always, never ]');
    expect(yaml).not.toContain('values: []');
    expect(yaml).not.toContain('subcommands: []');
    expect(yaml.startsWith('version: 1\nprogram: frob\n')).toBe(true);
  });
});

describe('readCliSpecFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cli-spec-'));
    mkdirSync(join(dir, 'port-anything'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads what cliSpecYaml wrote', async () => {
    writeFileSync(join(dir, CLI_SPEC_FILE), cliSpecYaml(parseCliSpec(SPEC)));
    expect(await readCliSpecFile(dir)).toEqual(parseCliSpec(SPEC));
  });

  it('reports a missing file, bad YAML and an invalid spec as ConfigError', async () => {
    await expect(readCliSpecFile(join(dir, 'nowhere'))).rejects.toThrow(/No port-anything\/cli-spec.yaml/);
    writeFileSync(join(dir, CLI_SPEC_FILE), 'version: 1\nversion: 1\n');
    await expect(readCliSpecFile(dir)).rejects.toThrow(/not valid YAML/);
    writeFileSync(join(dir, CLI_SPEC_FILE), 'version: 2\nprogram: frob\n');
    await expect(readCliSpecFile(dir)).rejects.toThrow(ConfigError);
  });
});

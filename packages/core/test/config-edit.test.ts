import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { appendNormalizers, normalizerEntry, setCorpusSettings } from '../src/config-edit.js';
import { parseConfig } from '../src/config.js';
import { NormalizersSchema, type NormalizerSpec } from '../src/normalize.js';

const PROPOSALS: { spec: NormalizerSpec; comment: string }[] = [
  { spec: { name: 'tmp-paths', options: {} }, comment: 'varied in 2 cases' },
  { spec: { name: 'iso-timestamps', options: {}, scope: ['stderr', 'files:out dir/report.txt'] }, comment: 'varied in 1 case' },
];

describe('normalizerEntry', () => {
  it('writes a name alone, or a map with the options, scope and features, that reads back as the same spec', () => {
    const specs = NormalizersSchema.parse(['pids', { 'sort-lines': null, scope: 'stdout' }, { 'float-tolerance': { rtol: 1e-6 }, scope: ['stdout', 'files:*.json'], features: ['fmt'] }]);
    const entries = specs.map(normalizerEntry);
    expect(entries).toEqual(['pids', { 'sort-lines': null, scope: 'stdout' }, { 'float-tolerance': { rtol: 1e-6, atol: 0 }, scope: ['stdout', 'files:*.json'], features: ['fmt'] }]);
    expect(NormalizersSchema.parse(entries)).toEqual(specs);
  });
});

describe('appendNormalizers', () => {
  it('adds lines after the last entry of an existing block list, in its indentation, keeping everything else byte for byte', () => {
    const source = [
      'version: 1   # spacing kept',
      'reference: {cmd: ./bin/tool}',
      'normalizers:',
      '    - ansi-codes',
      '    - regex:',
      '        pattern: "id=[0-9]+"   # ids',
      '    # - pids (not yet)',
      'sandbox:',
      '  timeout: 10s',
      '',
    ].join('\n');
    const edited = appendNormalizers(source, PROPOSALS);
    expect(edited).toBe(
      [
        ...source.split('\n').slice(0, 6),
        '    - tmp-paths # varied in 2 cases',
        '    - { iso-timestamps: null, scope: [ stderr, files:out dir/report.txt ] } # varied in 1 case',
        ...source.split('\n').slice(6),
      ].join('\n'),
    );
    expect(parseConfig(parse(edited)).normalizers.map((s) => s.name)).toEqual(['ansi-codes', 'regex', 'tmp-paths', 'iso-timestamps']);
    expect(parseConfig(parse(edited)).normalizers[3]).toEqual(PROPOSALS[1]!.spec);
  });

  it('adds lines right after a last entry that is a map followed by a blank line', () => {
    expect(appendNormalizers('normalizers:\n  - regex:\n      pattern: x\n\n# sandbox\nsandbox: {}\n', PROPOSALS.slice(0, 1))).toBe(
      'normalizers:\n  - regex:\n      pattern: x\n  - tmp-paths # varied in 2 cases\n\n# sandbox\nsandbox: {}\n',
    );
  });

  it('adds a normalizers list at the end when there is none', () => {
    expect(appendNormalizers('version: 1\nreference:\n  cmd: ./t', PROPOSALS)).toBe(
      'version: 1\nreference:\n  cmd: ./t\nnormalizers:\n  - tmp-paths # varied in 2 cases\n  - { iso-timestamps: null, scope: [ stderr, files:out dir/report.txt ] } # varied in 1 case\n',
    );
  });

  it('edits a flow or empty list through the YAML document, keeping comments', () => {
    const flow = appendNormalizers('# my config\nversion: 1\nnormalizers: [ansi-codes]\n', PROPOSALS);
    expect(flow).toMatch(/^# my config\n/);
    expect(parse(flow).normalizers).toEqual(['ansi-codes', 'tmp-paths', { 'iso-timestamps': null, scope: ['stderr', 'files:out dir/report.txt'] }]);
    const empty = appendNormalizers('version: 1\nnormalizers:\nsandbox: {}\n', PROPOSALS);
    expect(parse(empty).normalizers).toEqual(['tmp-paths', { 'iso-timestamps': null, scope: ['stderr', 'files:out dir/report.txt'] }]);
    expect(parse(empty).sandbox).toEqual({});
  });

  it('returns the source unchanged when there is nothing to add', () => {
    expect(appendNormalizers('version: 1\n', [])).toBe('version: 1\n');
  });
});

describe('setCorpusSettings', () => {
  it('sets keys in an existing corpus section, keeping the comments and the other keys', () => {
    const source = ['version: 1 # first', 'reference: { cmd: ./ref }', 'corpus:', '  repeats: 3 # three runs', '  generator: v1', ''].join('\n');
    const edited = setCorpusSettings(source, { generator: 'v1', generator_seed: 7, budget: 60 });
    expect(parse(edited)).toEqual({ version: 1, reference: { cmd: './ref' }, corpus: { repeats: 3, generator: 'v1', generator_seed: 7, budget: 60 } });
    expect(edited).toContain('version: 1 # first');
    expect(edited).toContain('repeats: 3 # three runs');
    expect(parseConfig(parse(edited)).corpus?.generator_seed).toBe(7);
  });

  it('adds the section when it is missing, and leaves the text alone when nothing changes', () => {
    const source = 'version: 1\nreference: { cmd: ./ref }\n';
    const edited = setCorpusSettings(source, { generator: 'v1', generator_seed: 42 });
    expect(parse(edited).corpus).toEqual({ generator: 'v1', generator_seed: 42 });
    expect(setCorpusSettings(edited, { generator: 'v1', generator_seed: 42 })).toBe(edited);
  });
});

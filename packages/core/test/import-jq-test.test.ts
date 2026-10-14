import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { parseJqTest } from '../src/import-jq-test.js';
import { importCases } from '../src/importers.js';

// Written for these tests in jq's test format; not taken from jq's suite.
const SAMPLE = `# Tests are groups of three lines: program, input, expected output

.a
{"a": 1}
1

  # an indented comment is a comment too
.[]
[1, 2]
1
2
# a comment ends the expected output
-1
null
-1

%%FAIL
{(0):1}
jq: error: Cannot use number (0) as object key

%%FAIL IGNORE MSG
. as [] | null
jq: error: syntax error

empty
null

`;

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-jq-test-'));
  store = new BlobStore(join(dir, 'cache'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseJqTest', () => {
  it("reads programs, inputs and expectations the way jq's runner does", () => {
    const { tests, problems } = parseJqTest(SAMPLE);
    expect(problems).toEqual([]);
    expect(tests).toEqual([
      { line: 3, program: '.a', input: '{"a": 1}', expected: { kind: 'output', lines: ['1'] } },
      { line: 8, program: '.[]', input: '[1, 2]', expected: { kind: 'output', lines: ['1', '2'] } },
      { line: 13, program: '-1', input: 'null', expected: { kind: 'output', lines: ['-1'] } },
      { line: 18, program: '{(0):1}', input: null, expected: { kind: 'error', message: 'jq: error: Cannot use number (0) as object key', exactMessage: true } },
      { line: 22, program: '. as [] | null', input: null, expected: { kind: 'error', message: 'jq: error: syntax error', exactMessage: false } },
      { line: 25, program: 'empty', input: 'null', expected: { kind: 'output', lines: [] } },
    ]);
  });

  it('reads CRLF files like LF files', () => {
    expect(parseJqTest(SAMPLE.replaceAll('\n', '\r\n'))).toEqual(parseJqTest(SAMPLE));
  });

  it('takes the input line as is, like jq, even when it looks like a comment', () => {
    expect(parseJqTest('.\n# not a comment\n').tests).toEqual([
      { line: 1, program: '.', input: '# not a comment', expected: { kind: 'output', lines: [] } },
    ]);
  });

  it('reports a test cut short by the end of the file', () => {
    expect(parseJqTest('.a\n')).toEqual({ tests: [], problems: [{ line: 1, message: 'file ends before the input line' }] });
    expect(parseJqTest('%%FAIL\n{(0):1}')).toEqual({ tests: [], problems: [{ line: 2, message: 'file ends before the expected error message' }] });
  });
});

describe('importCases: jq-test', () => {
  it('turns each test into an imported case: the program as argv, the input on stdin', async () => {
    await writeFile(join(dir, 'LICENSE'), 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software');
    await writeFile(join(dir, 'sample.test'), SAMPLE);
    const result = await importCases({ kind: 'jq-test', path: join(dir, 'sample.test') }, store);
    expect(result.kind).toBe('jq-test');
    expect(result.license).toMatchObject({ licenses: ['MIT'], category: 'permissive' });
    expect(result.skipped).toEqual([]);
    expect(result.cases.map((c) => [c.case.argv, c.case.stdin])).toEqual([
      [['.a'], blobRef('{"a": 1}\n')],
      [['.[]'], blobRef('[1, 2]\n')],
      [['--', '-1'], blobRef('null\n')],
      [['{(0):1}'], null],
      [['. as [] | null'], null],
      [['empty'], blobRef('null\n')],
    ]);
    expect(result.cases.every((c) => c.case.origin === 'imported')).toBe(true);
    expect(result.cases[1]!.at).toEqual({ file: join(dir, 'sample.test'), line: 8 });
    expect(result.cases[1]!.expected).toEqual({ kind: 'output', lines: ['1', '2'] });
    expect((await store.get(blobRef('[1, 2]\n'))).toString()).toBe('[1, 2]\n');
  });

  it('puts extra arguments before the program and de-duplicates repeated tests', async () => {
    await writeFile(join(dir, 'dup.test'), '.\n1\n1\n\n.\n1\n1\n\n-.\n1\n-1\n');
    const result = await importCases({ kind: 'jq-test', path: join(dir, 'dup.test'), args: ['-c'], license: 'MIT' }, store);
    expect(result.cases.map((c) => c.case.argv)).toEqual([['-c', '.'], ['-c', '--', '-.']]);
    expect(result.duplicates).toEqual([{ file: join(dir, 'dup.test'), line: 5 }]);
  });

  it('keeps the bytes of the input line, byte order mark included', async () => {
    await writeFile(join(dir, 'bom.test'), '.\n﻿"x"\n"x"\n');
    const result = await importCases({ kind: 'jq-test', path: join(dir, 'bom.test'), license: 'MIT' }, store);
    expect(result.cases[0]!.case.stdin).toBe(blobRef('﻿"x"\n'));
  });

  it('skips a test the case model rejects and reports truncated ones', async () => {
    await writeFile(join(dir, 'bad.test'), '"a\0b"\nnull\n"a"\n\n.b\n');
    const result = await importCases({ kind: 'jq-test', path: join(dir, 'bad.test'), license: 'MIT' }, store);
    expect(result.cases).toEqual([]);
    expect(result.skipped).toEqual([
      { at: { file: join(dir, 'bad.test'), line: 5 }, reason: 'file ends before the input line' },
      { at: { file: join(dir, 'bad.test'), line: 1 }, reason: expect.stringMatching(/NUL byte/) },
    ]);
  });

  it('refuses a file that is not UTF-8', async () => {
    await writeFile(join(dir, 'latin1.test'), Buffer.from([0x2e, 0x0a, 0xe9, 0x0a]));
    await expect(importCases({ kind: 'jq-test', path: join(dir, 'latin1.test'), license: 'MIT' }, store)).rejects.toThrow(/not valid UTF-8/);
  });
});

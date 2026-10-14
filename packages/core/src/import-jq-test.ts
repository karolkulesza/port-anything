import { readFile } from 'node:fs/promises';
import type { ImportExpectation, ImportOptionsBase, Importer } from './import.js';

/** One test from a jq test file. `input` is null for `%%FAIL` tests, which only compile the program. */
export interface JqTest {
  /** 1-based line of the program. */
  line: number;
  program: string;
  input: string | null;
  expected: ImportExpectation;
}

export interface JqTestParse {
  tests: JqTest[];
  /** Tests cut short by the end of the file, by line. */
  problems: { line: number; message: string }[];
}

// jq's own runner (src/jq_test.c) skips a line that is empty or whose first non-blank character is
// `#`, both between tests and as the end of a test's expected output.
const isSkipLine = (line: string) => /^[ \t]*(#|$)/.test(line);

/**
 * Parses jq's test format (`tests/jq.test`, also used by jaq and gojq) the way jq's runner reads
 * it: a program line, an input line (one JSON text), then expected output lines up to the next
 * blank or comment line. `%%FAIL` (or `%%FAIL IGNORE MSG`) before a program marks a test whose
 * program must fail to compile, followed by one line with the error message. CRLF line ends are
 * read as LF.
 */
export function parseJqTest(text: string): JqTestParse {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  const tests: JqTest[] = [];
  const problems: JqTestParse['problems'] = [];
  let i = 0;
  let fail: 'message' | 'any' | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (isSkipLine(line)) continue;
    if (line === '%%FAIL' || line === '%%FAIL IGNORE MSG') {
      fail = line === '%%FAIL' ? 'message' : 'any';
      continue;
    }
    const at = i;
    if (fail !== null) {
      if (i >= lines.length) {
        problems.push({ line: at, message: 'file ends before the expected error message' });
        break;
      }
      tests.push({ line: at, program: line, input: null, expected: { kind: 'error', message: lines[i]!, exactMessage: fail === 'message' } });
      i++;
      fail = null;
      continue;
    }
    // Like jq's runner, the input line is taken as is, even when blank.
    if (i >= lines.length) {
      problems.push({ line: at, message: 'file ends before the input line' });
      break;
    }
    const input = lines[i]!;
    i++;
    const output: string[] = [];
    while (i < lines.length && !isSkipLine(lines[i]!)) output.push(lines[i++]!);
    tests.push({ line: at, program: line, input, expected: { kind: 'output', lines: output } });
  }
  return { tests, problems };
}

export interface JqTestImportOptions extends ImportOptionsBase {
  /** Arguments before the program, e.g. `['-c']`. Default: none. */
  args?: string[];
}

/**
 * Imports a jq test file. Each test becomes `<args> <program>` with the input line (plus a
 * newline) on stdin; `%%FAIL` tests get `/dev/null` as stdin. A program starting with `-` is put
 * after `--` so it isn't read as an option. Tests that use jq's test modules (`import`/`include`,
 * run with `-L tests/modules` upstream) are imported as written, without the modules.
 */
export const jqTestImporter: Importer<JqTestImportOptions> = {
  kind: 'jq-test',
  async read(options, collector) {
    const file = options.path;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
    } catch (e) {
      if (e instanceof TypeError) throw new Error(`${file} is not valid UTF-8.`);
      throw e;
    }
    const { tests, problems } = parseJqTest(text);
    for (const p of problems) collector.skip({ file, line: p.line }, p.message);
    const args = options.args ?? [];
    for (const t of tests) {
      await collector.add({
        argv: [...args, ...(t.program.startsWith('-') ? ['--'] : []), t.program],
        stdin: t.input === null ? null : `${t.input}\n`,
        at: { file, line: t.line },
        expected: t.expected,
      });
    }
  },
};

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { symlinkBlob } from '../src/fs-diff.js';
import type { Observation } from '../src/model.js';
import {
  NormalizersSchema,
  globRegex,
  normalizePair,
  normalizerLabel,
  type NormalizerSpec,
  type SideContext,
} from '../src/normalize.js';

let dir: string;
let store: BlobStore;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-normalize-'));
  store = new BlobStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spec = (...entries: unknown[]): NormalizerSpec[] => NormalizersSchema.parse(entries);

const REF_CTX: SideContext = { tempRoots: ['/work/run-1/slot-0/case', '/work/run-1/programs/side-0', '/work/run-1'], programNames: ['sort'] };
const CAND_CTX: SideContext = { tempRoots: ['/work/run-1/slot-0/case', '/work/run-1/programs/side-1', '/work/run-1'], programNames: ['sort', 'uu-sort'] };

async function observation(stdout: string | Buffer, stderr: string | Buffer = '', files: Record<string, string | Buffer> = {}): Promise<Observation> {
  const created: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) created[path] = await store.put(content);
  return {
    exit: 0,
    signal: null,
    timeout: false,
    stdout: await store.put(stdout),
    stderr: await store.put(stderr),
    fs: { created, modified: {}, deleted: [] },
    time_ms: { wall: 1, user: null, sys: null },
    rss_kb: null,
    runs: 1,
    stable: true,
  };
}

/** Normalizes one text on both sides (reference and candidate) and returns the results. */
async function normalizeText(normalizers: NormalizerSpec[], reference: string, candidate = reference, field: 'stdout' | 'stderr' = 'stdout') {
  const [r, c] = field === 'stdout' ? [await observation(reference), await observation(candidate)] : [await observation('', reference), await observation('', candidate)];
  const result = await normalizePair({ normalizers, features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: c, context: CAND_CTX }, store });
  const text = async (o: Observation) => (await store.get(o[field])).toString('utf8');
  return { reference: await text(result.reference), candidate: await text(result.candidate), changedBy: result.changedBy, result };
}

describe('NormalizersSchema', () => {
  it('reads names, options, scope and features', () => {
    expect(spec('tmp-paths', { 'float-tolerance': { rtol: 1e-6 }, scope: 'stdout', features: ['fmt.json'] })).toEqual([
      { name: 'tmp-paths', options: {} },
      { name: 'float-tolerance', options: { rtol: 1e-6, atol: 0 }, scope: ['stdout'], features: ['fmt.json'] },
    ]);
    expect(spec({ regex: { pattern: 'id=\\d+', replacement: 'id=N' } }, { pids: null, scope: ['stderr', 'files:out/*.log'] })).toEqual([
      { name: 'regex', options: { pattern: 'id=\\d+', replacement: 'id=N', flags: '' } },
      { name: 'pids', options: {}, scope: ['stderr', 'files:out/*.log'] },
    ]);
    expect(spec('float-tolerance')).toEqual([{ name: 'float-tolerance', options: { rtol: 1e-9, atol: 0 } }]);
  });

  it('rejects unknown names, bad options, scopes and features', () => {
    const fails = (entry: unknown, message: RegExp) => {
      const result = NormalizersSchema.safeParse([entry]);
      expect(result.success).toBe(false);
      expect(result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')).toMatch(message);
    };
    fails('tmp-path', /unknown normalizer "tmp-path"/);
    fails('regex', /regex: needs options/);
    fails({ regex: { pattern: '(' } }, /regex\.pattern: is not a valid regular expression/);
    fails({ regex: { pattern: 'a', flags: 'g' } }, /flags/);
    fails({ 'tmp-paths': { x: 1 } }, /tmp-paths/);
    fails({ 'float-tolerance': { rtol: -1 } }, /float-tolerance\.rtol/);
    fails({ pids: null, 'tmp-paths': null }, /exactly one normalizer, found pids, tmp-paths/);
    fails({ scope: 'stdout' }, /exactly one normalizer, found none/);
    fails({ pids: null, scope: 'stdin' }, /scope.*stdout, stderr, files or files:<glob>/);
    fails({ pids: null, scope: 'files:' }, /scope/);
    fails({ pids: null, features: [] }, /features/);
  });

  it('labels each normalizer with its options, scope and features', () => {
    expect(spec('tmp-paths', { 'float-tolerance': { rtol: 1e-6 }, scope: 'stdout', features: ['fmt.json'] }, { regex: { pattern: 'a+', replacement: 'A', flags: 'i' } }).map(normalizerLabel)).toEqual([
      'tmp-paths',
      'float-tolerance(rtol=0.000001, atol=0) on stdout for fmt.json',
      'regex(/a+/i → "A")',
    ]);
  });
});

describe('tmp-paths', () => {
  const n = spec('tmp-paths');

  it("replaces each side's case, program and scratch directories, longest first", async () => {
    const out = await normalizeText(n, 'wrote /work/run-1/slot-0/case/out.txt via /work/run-1/programs/side-0/sort\n', 'wrote /work/run-1/slot-0/case/out.txt via /work/run-1/programs/side-1/sort\n');
    expect(out.reference).toBe('wrote <TMP>/out.txt via <TMP>/sort\n');
    expect(out.candidate).toBe(out.reference);
    expect(out.changedBy).toEqual([0]);
  });

  it('replaces system temp entries but not lookalikes', async () => {
    const out = await normalizeText(n, 'a /tmp/tmp.XyZ12/f b /private/var/folders/ab/cd123/T/foo.1/x c /var/tmp/q d /dev/shm/s e /home/u/tmp/keep f /work/run-10\n');
    expect(out.reference).toBe('a <TMP>/f b <TMP>/x c <TMP> d <TMP> e /home/u/tmp/keep f /work/run-10\n');
  });

  it('counts nothing when there is nothing to replace', async () => {
    expect((await normalizeText(n, 'plain\n')).changedBy).toEqual([]);
  });
});

describe('iso-timestamps', () => {
  const n = spec('iso-timestamps');
  it('replaces date-times in the usual ISO 8601 / RFC 3339 forms', async () => {
    const out = await normalizeText(n, '2026-10-14T11:51:56Z|2026-10-14T11:51|2026-10-14 11:51:56.123+02:00|2026-10-14T11:51:56,5-0500\n');
    expect(out.reference).toBe('<TIMESTAMP>|<TIMESTAMP>|<TIMESTAMP>|<TIMESTAMP>\n');
  });
  it('leaves dates, times and longer digit runs alone', async () => {
    const text = 'on 2026-10-14 at 11:51:56, v12026-10-14T11:51 x\n';
    expect((await normalizeText(n, text)).reference).toBe(text);
  });
});

describe('pids', () => {
  const n = spec('pids');
  it('replaces pid-labelled numbers', async () => {
    const out = await normalizeText(n, 'pid 123, PID: 9, pid=77, pids 5\n', 'pid 456, PID: 10, pid=78, pids 6\n');
    expect(out.reference).toBe('pid <PID>, PID: <PID>, pid=<PID>, pids <PID>\n');
    expect(out.candidate).toBe(out.reference);
  });
  it('leaves other numbers, indexes and numbers on the next line alone', async () => {
    const text = 'rapid 123 .a[0] x[12] 4242\nitems[3]: bad\nsort[4242]: done\npid\n42\n';
    expect((await normalizeText(n, text)).reference).toBe(text);
  });
});

describe('ansi-codes', () => {
  it('strips colors, cursor moves, OSC titles/links and two-byte escapes', async () => {
    const out = await normalizeText(spec('ansi-codes'), '\x1b[1;31mred\x1b[0m \x1b[2K\x1b]0;title\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ \x1bMup\n', 'red link up\n');
    expect(out.reference).toBe('red link up\n');
    expect(out.candidate).toBe('red link up\n');
    expect(out.changedBy).toEqual([0]);
  });
});

describe('trailing-whitespace', () => {
  it('removes spaces and tabs at the end of every line, keeping CR and blank lines', async () => {
    const out = await normalizeText(spec('trailing-whitespace'), 'a  \nb\t\r\n\n  c \t');
    expect(out.reference).toBe('a\nb\r\n\n  c');
  });

  it('leaves bytes 0x85 and 0xA0 of output that is not UTF-8 alone', async () => {
    // 0xff makes it invalid UTF-8; "à" (c3 a0) and "Å" (c3 85) end in bytes that are Unicode spaces in latin1.
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from('voilà\nÅ \n')]);
    const r = await observation(bytes);
    const result = await normalizePair({ normalizers: spec('trailing-whitespace'), features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: r, context: CAND_CTX }, store });
    expect(await store.get(result.reference.stdout)).toEqual(Buffer.concat([Buffer.from([0xff]), Buffer.from('voilà\nÅ\n')]));
  });
});

describe('float-tolerance', () => {
  it("rewrites the candidate's floats that are within tolerance to the reference's spelling", async () => {
    const out = await normalizeText(spec('float-tolerance'), 'x=0.30000000000000004 y=1e-3\n', 'x=0.3 y=0.001\n');
    expect(out.candidate).toBe('x=0.30000000000000004 y=1e-3\n');
    expect(out.reference).toBe('x=0.30000000000000004 y=1e-3\n');
    expect(out.changedBy).toEqual([0]);
  });

  it('keeps numbers outside tolerance, integers, and texts with a different count of numbers', async () => {
    const n = spec({ 'float-tolerance': { rtol: 1e-3 } });
    expect((await normalizeText(n, '1.000 2.0\n', '1.0005 2.1\n')).candidate).toBe('1.000 2.1\n');
    expect((await normalizeText(n, '1000\n', '1001\n')).candidate).toBe('1001\n');
    expect((await normalizeText(n, '1.0 2.0\n', '1.0001\n')).candidate).toBe('1.0001\n');
  });

  it('takes floats followed by a unit or a full stop, but not versions', async () => {
    const n = spec('float-tolerance');
    expect((await normalizeText(n, 'mean is 1.5. took 0.30000000000000004s\n', 'mean is 1.5000000000001. took 0.3s\n')).candidate).toBe('mean is 1.5. took 0.30000000000000004s\n');
    expect((await normalizeText(n, 'v 1.2.3\n', 'v 1.2.4\n')).candidate).toBe('v 1.2.4\n');
    // An integer before a full stop stays an integer.
    expect((await normalizeText(spec({ 'float-tolerance': { atol: 1 } }), 'exit 3.\n', 'exit 4.\n')).candidate).toBe('exit 4.\n');
  });

  it('uses atol near zero', async () => {
    expect((await normalizeText(spec({ 'float-tolerance': { atol: 1e-6 } }), '0.0\n', '1e-9\n')).candidate).toBe('0.0\n');
    expect((await normalizeText(spec('float-tolerance'), '0.0\n', '1e-9\n')).candidate).toBe('1e-9\n');
  });
});

describe('regex', () => {
  it('replaces every match, with capture groups and flags', async () => {
    const out = await normalizeText(spec({ regex: { pattern: '(id)=[0-9a-f]+', replacement: '$1=<ID>', flags: 'i' } }), 'ID=ab12 id=ff\n', 'ID=99 id=0\n');
    expect(out.reference).toBe('ID=<ID> id=<ID>\n');
    expect(out.candidate).toBe(out.reference);
  });
  it('writes a replacement that latin1 cannot hold as UTF-8 into output that is not UTF-8', async () => {
    const r = await observation(Buffer.concat([Buffer.from([0xff]), Buffer.from(' a->b\n')]));
    const result = await normalizePair({ normalizers: spec({ regex: { pattern: '->', replacement: '→' } }), features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: r, context: CAND_CTX }, store });
    expect(await store.get(result.reference.stdout)).toEqual(Buffer.concat([Buffer.from([0xff]), Buffer.from(' a→b\n')]));
  });

  it('replaces with nothing by default', async () => {
    expect((await normalizeText(spec({ regex: { pattern: ' took \\d+ms' } }), 'done took 12ms\n')).reference).toBe('done\n');
  });
});

describe('program-name', () => {
  const n = spec('program-name');
  it("replaces each side's own name where tools print it, in stderr", async () => {
    const out = await normalizeText(
      n,
      "sort: invalid option -- 'z'\nUsage: sort [OPTION]...\nTry 'sort --help' for more information.\n",
      "uu-sort: invalid option -- 'z'\nUsage: /usr/bin/uu-sort [OPTION]...\nTry 'uu-sort --help' for more information.\n",
      'stderr',
    );
    expect(out.reference).toBe("<PROGRAM>: invalid option -- 'z'\nUsage: <PROGRAM> [OPTION]...\nTry '<PROGRAM> --help' for more information.\n");
    expect(out.candidate).toBe(out.reference);
  });

  it('leaves the name alone inside a message, and leaves stdout alone by default', async () => {
    const err = await normalizeText(n, 'sort: cannot sort input\n', 'uu-sort: cannot sort input\n', 'stderr');
    expect(err.reference).toBe('<PROGRAM>: cannot sort input\n');
    expect(err.candidate).toBe(err.reference);
    expect((await normalizeText(n, 'sort: x\n')).changedBy).toEqual([]);
    expect((await normalizeText(n, 'sorted: x\n', 'sorted: x\n', 'stderr')).changedBy).toEqual([]);
  });
});

describe('normalizePair', () => {
  it('applies normalizers in order, so a later one sees the output of an earlier one', async () => {
    const regexFirst = spec({ regex: { pattern: '<TMP>', replacement: 'T' } }, 'tmp-paths');
    const tmpFirst = spec('tmp-paths', { regex: { pattern: '<TMP>', replacement: 'T' } });
    expect((await normalizeText(regexFirst, '/tmp/x\n')).reference).toBe('<TMP>\n');
    const later = await normalizeText(tmpFirst, '/tmp/x\n');
    expect(later.reference).toBe('T\n');
    expect(later.changedBy).toEqual([0, 1]);
  });

  it('respects scope: fields, all files, and file globs', async () => {
    const r = await observation('/tmp/a\n', '/tmp/a\n', { 'out/x.log': '/tmp/a\n', 'out/y.txt': '/tmp/a\n', 'deep/out/z.log': '/tmp/a\n' });
    const run = async (normalizers: NormalizerSpec[]) => {
      const result = await normalizePair({ normalizers, features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: r, context: CAND_CTX }, store });
      const show = async (ref: string) => (await store.get(ref)).toString();
      const o = result.reference;
      return [await show(o.stdout), await show(o.stderr), ...(await Promise.all(Object.keys(o.fs.created).sort().map((p) => show(o.fs.created[p]!))))].map((t) => (t === '<TMP>\n' ? 'N' : '-')).join('');
    };
    // Order: stdout, stderr, deep/out/z.log, out/x.log, out/y.txt
    expect(await run(spec('tmp-paths'))).toBe('NNNNN');
    expect(await run(spec({ 'tmp-paths': null, scope: 'stdout' }))).toBe('N----');
    expect(await run(spec({ 'tmp-paths': null, scope: ['stderr', 'files'] }))).toBe('-NNNN');
    expect(await run(spec({ 'tmp-paths': null, scope: 'files:out/*.log' }))).toBe('---N-');
    expect(await run(spec({ 'tmp-paths': null, scope: 'files:**/*.log' }))).toBe('--NN-');
  });

  it('respects features, a feature covering its sub-features', async () => {
    const r = await observation('/tmp/a\n');
    const changed = async (features: string[]) =>
      (await normalizePair({ normalizers: spec({ 'tmp-paths': null, features: ['fmt'] }), features, reference: { observation: r, context: REF_CTX }, candidate: { observation: r, context: CAND_CTX }, store })).changedBy;
    expect(await changed(['fmt'])).toEqual([0]);
    expect(await changed(['io', 'fmt.json'])).toEqual([0]);
    expect(await changed(['format'])).toEqual([]);
    expect(await changed([])).toEqual([]);
  });

  it('normalizes a file only one side wrote, and leaves symlinks and unstored files alone', async () => {
    const r = await observation('', '', { 'a.txt': '/tmp/x\n' });
    const c = await observation('', '');
    c.fs.created['link'] = blobRef(symlinkBlob('/tmp/x'));
    c.fs.created['big.bin'] = blobRef('/tmp/not-stored\n');
    const result = await normalizePair({ normalizers: spec('tmp-paths'), features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: c, context: CAND_CTX }, store });
    expect((await store.get(result.reference.fs.created['a.txt']!)).toString()).toBe('<TMP>\n');
    expect(result.candidate.fs.created).toEqual(c.fs.created);
    expect(result.changedBy).toEqual([0]);
  });

  it('keeps non-UTF-8 output byte for byte apart from the rewritten parts', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(' /tmp/abc\n')]);
    const r = await observation(bytes);
    const result = await normalizePair({ normalizers: spec('tmp-paths'), features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: r, context: CAND_CTX }, store });
    expect(await store.get(result.reference.stdout)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(' <TMP>\n')]));
  });

  it('returns the observations unchanged (same refs) when nothing applies', async () => {
    const r = await observation('plain\n');
    const c = await observation('other\n');
    const result = await normalizePair({ normalizers: spec('tmp-paths', 'pids'), features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: c, context: CAND_CTX }, store });
    expect(result).toEqual({ reference: r, candidate: c, changedBy: [] });
    expect(await normalizePair({ normalizers: [], features: [], reference: { observation: r, context: REF_CTX }, candidate: { observation: c, context: CAND_CTX }, store })).toEqual({ reference: r, candidate: c, changedBy: [] });
  });

  it('never touches exit code, signal, timeout or the original observation', async () => {
    const r = await observation('/tmp/a\n', '', { 'f': '/tmp/a\n' });
    const before = structuredClone(r);
    const result = await normalizePair({ normalizers: spec('tmp-paths'), features: [], reference: { observation: { ...r, exit: 2 }, context: REF_CTX }, candidate: { observation: r, context: CAND_CTX }, store });
    expect(result.reference.exit).toBe(2);
    expect(r).toEqual(before);
  });
});

describe('globRegex', () => {
  it('matches * and ? within a segment and ** across segments', () => {
    expect(globRegex('*.log').test('a.log')).toBe(true);
    expect(globRegex('*.log').test('d/a.log')).toBe(false);
    expect(globRegex('**/*.log').test('a.log')).toBe(true);
    expect(globRegex('**/*.log').test('d/e/a.log')).toBe(true);
    expect(globRegex('out/**').test('out/a/b')).toBe(true);
    expect(globRegex('f?.txt').test('f1.txt')).toBe(true);
    expect(globRegex('f?.txt').test('f/.txt')).toBe(false);
    expect(globRegex('a+b.txt').test('a+b.txt')).toBe(true);
  });
});

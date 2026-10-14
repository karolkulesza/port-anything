import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import {
  COMPARED_FIELDS,
  PROFILES,
  PROFILE_FIELDS,
  compareExact,
  compareObservations,
  exitClass,
  stderrSimilarity,
  type CompareOptions,
} from '../src/compare.js';
import type { Observation } from '../src/model.js';

const observation = (over: Partial<Observation> = {}): Observation => ({
  exit: 0,
  signal: null,
  timeout: false,
  stdout: blobRef('out\n'),
  stderr: blobRef(''),
  fs: { created: { 'a.txt': blobRef('a') }, modified: {}, deleted: [] },
  time_ms: { wall: 12, user: null, sys: null },
  rss_kb: null,
  runs: 1,
  stable: true,
  ...over,
});

describe('compareExact', () => {
  it('matches identical observations', () => {
    expect(compareExact(observation(), observation())).toEqual({ verdict: 'match', fields: [] });
  });

  it('ignores time, memory and run counts', () => {
    const other = observation({ time_ms: { wall: 900, user: 3, sys: 1 }, rss_kb: 2048, runs: 3, stable: false });
    expect(compareExact(observation(), other).verdict).toBe('match');
  });

  it('names every field that differs, in a fixed order', () => {
    const other = observation({
      exit: null,
      signal: 'SIGKILL',
      timeout: true,
      stdout: blobRef('other\n'),
      stderr: blobRef('boom\n'),
      fs: { created: {}, modified: {}, deleted: [] },
    });
    expect(compareExact(observation(), other)).toEqual({ verdict: 'diverge', fields: [...COMPARED_FIELDS] });
    expect(COMPARED_FIELDS).toEqual(['exit', 'signal', 'timeout', 'stdout', 'stderr', 'fs']);
  });

  it('compares the fs diff by content, whatever order its keys are in', () => {
    const a = observation({ fs: { created: { 'x': blobRef('1'), 'y': blobRef('2') }, modified: {}, deleted: ['b', 'c'] } });
    const b = observation({ fs: { created: { 'y': blobRef('2'), 'x': blobRef('1') }, modified: {}, deleted: ['c', 'b'] } });
    expect(compareExact(a, b).verdict).toBe('match');
  });

  it('sees a file whose content differs, one that moved between created and modified, and an extra deletion', () => {
    const base = observation();
    expect(compareExact(base, observation({ fs: { created: { 'a.txt': blobRef('b') }, modified: {}, deleted: [] } })).fields).toEqual(['fs']);
    expect(compareExact(base, observation({ fs: { created: {}, modified: { 'a.txt': blobRef('a') }, deleted: [] } })).fields).toEqual(['fs']);
    expect(compareExact(base, observation({ fs: { ...base.fs, deleted: ['z'] } })).fields).toEqual(['fs']);
  });

  it('tells an exit code from a signal', () => {
    expect(compareExact(observation({ exit: 1 }), observation({ exit: 2 })).fields).toEqual(['exit']);
    expect(compareExact(observation({ exit: null, signal: 'SIGSEGV' }), observation({ exit: null, signal: 'SIGABRT' })).fields).toEqual(['signal']);
  });
});

describe('exitClass', () => {
  it('tells success, usage errors, other errors and signals apart', () => {
    expect(exitClass(observation())).toBe('success');
    expect(exitClass(observation({ exit: 2 }))).toBe('usage');
    expect(exitClass(observation({ exit: 64 }))).toBe('usage');
    expect(exitClass(observation({ exit: 1 }))).toBe('error');
    expect(exitClass(observation({ exit: 127 }))).toBe('error');
    expect(exitClass(observation({ exit: null, signal: 'SIGSEGV' }))).toBe('signal');
    expect(exitClass(observation({ exit: null, signal: 'SIGKILL', timeout: true }))).toBe('signal');
  });
});

describe('stderrSimilarity', () => {
  it('is 1 for the same words and 0 for none in common', () => {
    expect(stderrSimilarity('a b c', 'c b a')).toBe(1);
    expect(stderrSimilarity('a b', 'c d')).toBe(0);
  });

  it('is the share of words both messages have, ignoring case and punctuation', () => {
    // 7 of 9 words on each side are shared: 2 * 7 / 18.
    expect(stderrSimilarity("sort: cannot read: x: No such file or directory", 'sort: open failed: x: no such file or directory')).toBeCloseTo(14 / 18);
  });

  it('counts repeated words as often as they appear on both sides', () => {
    expect(stderrSimilarity('x x x y', 'x y')).toBeCloseTo((2 * 2) / 6);
  });
});

describe('compareObservations', () => {
  let dir: string;
  let store: BlobStore;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-compare-'));
    store = new BlobStore(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const names = { reference: ['cat'], candidate: ['cat', 'uu-cat'] };
  const failing = async (stderr: string, over: Partial<Observation> = {}) =>
    observation({ exit: 1, stdout: await store.put(''), stderr: await store.put(stderr), ...over });
  const compare = (a: Observation, b: Observation, options: Partial<CompareOptions> = {}) =>
    compareObservations(a, b, { profile: 'standard', ...options, store, programNames: names });

  it('diverges under standard on a different error message for the same failure', async () => {
    const ref = await failing('cat: nosuch: No such file or directory\n');
    const cand = await failing("error: could not open file 'nosuch'\n");
    expect(await compare(ref, cand)).toEqual({ verdict: 'diverge', fields: ['stderr'] });
  });

  it('matches under standard when only the program name or whitespace differs', async () => {
    const ref = await failing("cat: nosuch: No such file or directory\nTry 'cat --help' for more information.\n");
    const cand = await failing("uu-cat:  nosuch: No such file or directory  \n\nTry 'uu-cat --help' for more information.");
    expect(await compare(ref, cand)).toEqual({ verdict: 'match', fields: [] });
  });

  it('matches under standard when the wording is close enough, and the threshold is configurable', async () => {
    const ref = await failing('cat: cannot read: x: No such file or directory\n');
    const cand = await failing('cat: open failed: x: No such file or directory\n');
    expect((await compare(ref, cand)).verdict).toBe('match');
    expect((await compare(ref, cand, { stderr: { similarity: 0.9 } })).fields).toEqual(['stderr']);
  });

  it('diverges on stderr when only one side writes to it', async () => {
    const ref = await failing('');
    const cand = await failing('cat: warning\n');
    expect((await compare(ref, cand)).fields).toEqual(['stderr']);
    expect((await compare(cand, ref)).fields).toEqual(['stderr']);
  });

  it('diverges on stderr when the exit codes fall in different classes, even with the same message', async () => {
    const ref = await failing('cat: bad\n', { exit: 2 });
    const cand = await failing('cat: bad \n', { exit: 1 });
    expect((await compare(ref, cand)).fields).toEqual(['exit', 'stderr']);
    // Same class (other error), different code: only the exit code diverges.
    expect((await compare(await failing('cat: bad\n', { exit: 3 }), cand)).fields).toEqual(['exit']);
    // Loose never asks more than exact: the same bytes match whatever the exit codes.
    expect((await compare(ref, await failing('cat: bad\n', { exit: 1 }))).fields).toEqual(['exit']);
  });

  it('compares stderr byte for byte under strict, or when the stderr mode is exact', async () => {
    const ref = await failing('cat: x: No such file or directory\n');
    const cand = await failing('uu-cat: x: No such file or directory\n');
    expect(await compare(ref, cand, { profile: 'strict' })).toEqual({ verdict: 'diverge', fields: ['stderr'] });
    expect((await compare(ref, cand, { stderr: { mode: 'exact' } })).fields).toEqual(['stderr']);
    expect((await compare(ref, cand, { profile: 'strict', stderr: { mode: 'loose' } })).verdict).toBe('match');
  });

  it('counts the fs diff under strict and standard, but not under lenient', async () => {
    const ref = observation();
    const cand = observation({ fs: { created: {}, modified: {}, deleted: [] } });
    expect((await compare(ref, cand, { profile: 'strict' })).fields).toEqual(['fs']);
    expect((await compare(ref, cand)).fields).toEqual(['fs']);
    expect(await compare(ref, cand, { profile: 'lenient' })).toEqual({ verdict: 'match', fields: [] });
  });

  it('ignores stderr under lenient, but still counts exit status and stdout', async () => {
    const ref = await failing('cat: x: No such file or directory\n');
    const cand = await failing('something else entirely\n');
    expect((await compare(ref, cand, { profile: 'lenient' })).verdict).toBe('match');
    const other = observation({ exit: null, signal: 'SIGSEGV', stdout: blobRef('x\n') });
    expect((await compare(observation(), other, { profile: 'lenient' })).fields).toEqual(['exit', 'signal', 'stdout']);
  });

  it('lists the fields each profile counts', () => {
    expect(PROFILE_FIELDS).toEqual({
      strict: ['exit', 'signal', 'timeout', 'stdout', 'stderr', 'fs'],
      standard: ['exit', 'signal', 'timeout', 'stdout', 'stderr', 'fs'],
      lenient: ['exit', 'signal', 'timeout', 'stdout'],
    });
    expect(PROFILES).toEqual(['strict', 'standard', 'lenient']);
  });
});

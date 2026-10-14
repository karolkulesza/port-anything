import { describe, expect, it } from 'vitest';
import { blobRef } from '../src/blob-store.js';
import { COMPARED_FIELDS, compareExact } from '../src/compare.js';
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

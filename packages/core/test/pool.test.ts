import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { defaultConcurrency, mapPool } from '../src/pool.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapPool', () => {
  it('returns the results in input order, whatever order they finish in', async () => {
    const delays = [30, 5, 20, 0, 10];
    const results = await mapPool(delays, 3, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });
    expect(results).toEqual(['0:30', '1:5', '2:20', '3:0', '4:10']);
  });

  it('never runs more than the given number at once, and uses all of them', async () => {
    let running = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await tick(2);
      running--;
    });
    expect(peak).toBe(4);
  });

  it('gives each running item its own worker slot', async () => {
    const busy = new Set<number>();
    const slots = new Set<number>();
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async (_item, _i, slot) => {
      expect(busy.has(slot)).toBe(false);
      busy.add(slot);
      slots.add(slot);
      await tick(1);
      busy.delete(slot);
    });
    expect([...slots].sort()).toEqual([0, 1, 2]);
  });

  it('starts no new item after one fails, and rejects with that error', async () => {
    const started: number[] = [];
    const run = mapPool(Array.from({ length: 10 }, (_, i) => i), 2, async (i) => {
      started.push(i);
      await tick(1);
      if (i === 1) throw new Error('item 1 failed');
    });
    await expect(run).rejects.toThrow('item 1 failed');
    expect(started.length).toBeLessThan(10);
  });

  it('handles an empty list and more workers than items', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    expect(await mapPool([1, 2], 8, async (x) => x * 2)).toEqual([2, 4]);
  });

  it('refuses a concurrency that is not a positive integer', async () => {
    await expect(mapPool([1], 0, async (x) => x)).rejects.toThrow(/positive integer/);
    await expect(mapPool([1], 1.5, async (x) => x)).rejects.toThrow(/positive integer/);
  });
});

describe('defaultConcurrency', () => {
  it('is the number of CPU cores', () => {
    expect(defaultConcurrency()).toBe(availableParallelism());
  });
});

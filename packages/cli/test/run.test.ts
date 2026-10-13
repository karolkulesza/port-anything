import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

describe('run', () => {
  it('prints the not-released-yet notice and exits 0', () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rewrite it in any language and show nothing changed');
    expect(result.stdout).toContain('Not released yet.');
  });
});

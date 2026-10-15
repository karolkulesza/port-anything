import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareCommand, type CompareSummary } from '../src/compare-command.js';

// The zero-config demo on Linux, in a real bwrap sandbox: the system sort against the uutils
// multicall binary. Run in the dev container (scripts/dev-linux.sh), which has both.
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1' && existsSync('/usr/bin/coreutils'))('compare (Linux)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-compare-linux-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("compare /usr/bin/sort 'coreutils sort' finishes in under a minute", { timeout: 120_000 }, async () => {
    const started = Date.now();
    const result = await compareCommand(['/usr/bin/sort', 'coreutils sort', '--json'], { cwd: dir });
    const elapsed = Date.now() - started;
    expect(result.stderr).toBe('');
    expect([0, 1]).toContain(result.exitCode);
    const summary = JSON.parse(result.stdout) as CompareSummary;
    expect(summary).toMatchObject({ program_name: 'sort', sandbox: expect.stringMatching(/^bwrap, no network/) });
    expect(summary.corpus.cases).toBe(500);
    expect(summary.candidates[0]!.parity).not.toBeNull();
    expect(summary.candidates[0]!.features).toBeGreaterThan(10);
    for (const feature of ['opt.key', 'opt.numeric-sort', 'opt.reverse']) expect(summary.untested).not.toContain(feature);
    expect(elapsed).toBeLessThan(60_000);
  });
});

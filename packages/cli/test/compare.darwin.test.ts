import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareCommand, type CompareSummary } from '../src/compare-command.js';

const hasGsort = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v gsort'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The zero-config demo for Mac users: BSD sort against GNU sort from Homebrew coreutils, in the
// sandbox-exec sandbox.
describe.runIf(process.platform === 'darwin' && hasGsort)('compare (macOS)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-compare-darwin-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('compare /usr/bin/sort gsort works', { timeout: 180_000 }, async () => {
    const result = await compareCommand(['/usr/bin/sort', 'gsort', '--json'], { cwd: dir });
    // Nothing on stderr but, at most, the warning for features no case reached (BSD sort's -C gets none).
    expect(result.stderr).toMatch(/^(port-anything compare: warning: \d+ features? got no case \([^)]*\); [^\n]*\n)?$/);
    // BSD and GNU sort differ, so some cases diverge.
    expect(result.exitCode).toBe(1);
    const summary = JSON.parse(result.stdout) as CompareSummary;
    expect(summary).toMatchObject({ program_name: 'sort', sandbox: 'sandbox-exec, no network' });
    expect(summary.corpus.cases).toBe(500);
    const [gsort] = summary.candidates;
    expect(gsort!.command).toBe('gsort');
    expect(gsort!.parity).toBeGreaterThan(0);
    expect(gsort!.parity).toBeLessThan(1);
    // The README quickstart's sample output: BSD sort's -k, -n and -r all get cases.
    for (const feature of ['opt.k', 'opt.n', 'opt.r']) expect(summary.untested).not.toContain(feature);
  });
});

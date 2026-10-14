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
    expect(result.stderr).toBe('');
    // BSD and GNU sort differ, so some cases diverge.
    expect(result.exitCode).toBe(1);
    const summary = JSON.parse(result.stdout) as CompareSummary;
    expect(summary).toMatchObject({ program_name: 'sort', sandbox: 'sandbox-exec, no network' });
    expect(summary.corpus.cases).toBe(500);
    const [gsort] = summary.candidates;
    expect(gsort!.command).toBe('gsort');
    expect(gsort!.parity).toBeGreaterThan(0);
    expect(gsort!.parity).toBeLessThan(1);
  });
});

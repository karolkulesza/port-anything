import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blob-store.js';
import { parseProgramCommand, resolveProgram } from '../src/program.js';
import { inferCliSpec } from '../src/spec-infer.js';

// Spec inference and the probe set against real tools, in bwrap, in the dev container:
// scripts/dev-linux.sh pnpm -r test
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('inferCliSpec (Linux)', () => {
  let root: string;
  let scratch = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pa-spec-infer-linux-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const infer = async (cmd: string) =>
    inferCliSpec({
      reference: await resolveProgram(parseProgramCommand(cmd)),
      store: new BlobStore(join(root, 'cache')),
      sandbox: { kind: 'bwrap', isolatePids: true },
      workDir: join(root, `work-${scratch++}`),
    });

  it.each(['gnusort', 'gnuwc', 'sort', 'jq', 'busybox sort', 'toybox wc', 'git'])('%s: every probe passes', async (cmd) => {
    const { spec, probes } = await infer(cmd);
    expect(spec.flags.length).toBeGreaterThan(3);
    expect(probes.map((p) => p.kind)).toEqual(expect.arrayContaining(['unknown-long', 'unknown-short', 'known-flag']));
    expect(probes.filter((p) => p.status !== 'pass').map((p) => `${p.status} ${p.argv.join(' ')}: ${p.detail}`)).toEqual([]);
  });

  it('GNU true accepts unknown flags, and the probes say so', async () => {
    const { spec, probes } = await infer('gnutrue');
    expect(spec.flags.map((f) => f.feature)).toEqual(['opt.help', 'opt.version']);
    expect(probes.find((p) => p.kind === 'unknown-long')).toMatchObject({ status: 'fail', detail: 'exit 0: the program accepts the unknown flag --port-anything-no-such-flag' });
  });
});

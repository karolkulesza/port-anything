import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { caseScript, engineCpus, ensureImage, findContainerEngine, shellQuote } from '../src/container.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { NormalizersSchema } from '../src/normalize.js';
import { resolveProgram, type ResolvedProgram } from '../src/program.js';
import { observeCase, runCases } from '../src/run-cases.js';
import { containerSandbox, sandboxCommand } from '../src/sandbox.js';

const exec = promisify(execFile);

describe('container mode, without a container', () => {
  it('quotes any word for sh', async () => {
    const words = ['plain', "it's", 'a b', '$HOME `x` "y"', '\\n', ''];
    const { stdout } = await exec('sh', ['-c', `printf '%s\\n' ${words.map(shellQuote).join(' ')}`]);
    expect(stdout).toBe(words.map((w) => `${w}\n`).join(''));
  });

  it('writes a case script: its directory, a file size limit just over the cap, a clean environment, stdin', () => {
    const script = caseScript({ argv: ['tool', '-x', "it's"], cwd: '/w/slot-0/case', env: { HOME: '/w/slot-0/case', PATH: '/bin' }, stdin: Buffer.from('in') }, 1024, '/pa-io/7/stdin');
    expect(script).toBe(
      [
        "cd '/w/slot-0/case' || exit 126",
        'ulimit -f 3',
        "exec env -i 'HOME=/w/slot-0/case' 'PATH=/bin' 'PWD=/w/slot-0/case' 'tool' '-x' 'it'\\''s' <'/pa-io/7/stdin'",
        '',
      ].join('\n'),
    );
    expect(caseScript({ argv: ['tool'], cwd: '/c', env: {}, stdin: null }, 16 * 1024 * 1024, '/x')).toContain("ulimit -f 32769\nexec env -i 'PWD=/c' 'tool' </dev/null");
  });

  it('labels the sandbox with the engine and the image, and wraps no command', () => {
    const sandbox = containerSandbox({ engine: 'docker', image: 'debian:12-slim' });
    expect(sandbox).toEqual({ kind: 'container', engine: 'docker', image: 'debian:12-slim', label: 'container (docker, debian:12-slim), no network' });
    expect(() => sandboxCommand(sandbox, ['true'], '/tmp')).toThrow(/ContainerPool/);
  });

  it('refuses to observe a case in container mode without a pool', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-container-')));
    try {
      const c = canonicalCase({ argv: [], origin: 'recorded' });
      const side = { binDir: dir, args: [], readOnlyPaths: [] };
      const store = new BlobStore(join(dir, 'blobs'));
      await expect(observeCase(c, join(dir, 'case'), 'tool', side, { store, sandbox: containerSandbox({ engine: 'docker', image: 'x' }) })).rejects.toThrow(/container pool/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what each engine answered when none runs', async () => {
    await expect(findContainerEngine(['pa-no-such-engine-1', 'pa-no-such-engine-2'])).rejects.toThrow(
      /needs Docker or Podman running[\s\S]*pa-no-such-engine-1: [\s\S]*pa-no-such-engine-2: [\s\S]*set sandbox.mode to local/,
    );
  });

  it("knows no CPU count for an engine that doesn't answer", async () => {
    expect(await engineCpus('pa-no-such-engine')).toBeUndefined();
  });
});

// Runs real containers: wherever Docker or Podman answers, and always in CI on Linux (the runners have Docker).
const engine = await findContainerEngine().catch(() => undefined);
const required = process.env.CI !== undefined && process.platform === 'linux';
const IMAGE = 'debian:12-slim';

// Shell scripts run the same on the host and in the image. Each prints what one case asks about.
const TOOL = (variant: 'ref' | 'bad') => `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${variant === 'bad' ? 'cat' : "tr 'a-z' 'A-Z'"} ;;
  cat) shift; cat "$@" ;;
  write) echo made > out.txt; rm -f gone.txt ;;
  where) pwd; echo "$HOME"; echo "$0" ;;
  path) echo "$PATH" ;;
  net) cat /proc/net/route ;;
  root) touch /made-by-a-case ;;
  see) ls "$2" ;;
  sleep) sleep "$2"; echo woke ;;
  big) head -c "$2" /dev/zero ;;
  status) exit "$2" ;;
esac
`;

describe.runIf(engine !== undefined || required)(`container mode, in ${IMAGE}`, () => {
  let dir: string;
  let store: BlobStore;
  let ref: ResolvedProgram;
  let bad: ResolvedProgram;

  beforeAll(async () => {
    if (engine === undefined) throw new Error('No container engine answers (docker info, podman info).');
    await ensureImage(engine, IMAGE);
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-container-')));
    store = new BlobStore(join(dir, 'blobs'));
    for (const variant of ['ref', 'bad'] as const) {
      writeFileSync(join(dir, variant), TOOL(variant));
      chmodSync(join(dir, variant), 0o755);
    }
    ref = await resolveProgram({ executable: join(dir, 'ref'), args: [] });
    bad = await resolveProgram({ executable: join(dir, 'bad'), args: [] });
  }, 300_000);
  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  const text = async (ref: string) => (await store.get(ref)).toString('utf8');
  const make = async (input: { argv: string[]; stdin?: string; fixtures?: Record<string, string> }): Promise<CanonicalCase> => {
    const fixtures: Record<string, string> = {};
    for (const [path, content] of Object.entries(input.fixtures ?? {})) fixtures[path] = await store.put(Buffer.from(content));
    return canonicalCase({ origin: 'recorded', argv: input.argv, stdin: input.stdin === undefined ? null : await store.put(Buffer.from(input.stdin)), fixtures });
  };
  const sandbox = () => containerSandbox({ engine: engine!, image: IMAGE });

  it("reads the CPUs the engine's containers get", async () => {
    const cpus = await engineCpus(engine!);
    expect(Number.isInteger(cpus) && cpus! > 0, String(cpus)).toBe(true);
  });

  it('runs every case of each side in its own long-lived containers and compares them (done when)', async () => {
    const cases = await Promise.all([
      make({ argv: ['echo', 'hello', 'world'] }),
      make({ argv: ['upper'], stdin: 'abc\n' }),
      make({ argv: ['cat', 'a.txt'], fixtures: { 'a.txt': 'fixture\n' } }),
      make({ argv: ['write'], fixtures: { 'gone.txt': 'x' } }),
      make({ argv: ['where'] }),
      make({ argv: ['status', '3'] }),
    ]);
    const workDir = join(dir, 'run');
    // tmp-paths: each side's $0 is in its own directory of the run.
    const normalizers = NormalizersSchema.parse(['tmp-paths']);
    const result = await runCases({ reference: ref, candidates: [ref, bad], cases, store, sandbox: sandbox(), workDir, programName: 'tool', concurrency: 2, normalizers });
    const [echo, upper, cat, write, where, status] = result.cases;
    expect(await text(echo!.reference.stdout)).toBe('hello world\n');
    expect(await text(upper!.reference.stdout)).toBe('ABC\n');
    expect(await text(cat!.reference.stdout)).toBe('fixture\n');
    expect(write!.reference.fs).toMatchObject({ created: { 'out.txt': blobRef(Buffer.from('made\n')) }, deleted: ['gone.txt'] });
    expect(status!.reference.exit).toBe(3);
    // Both sides see the same case directory (the slot's, in the run's scratch directory) as their HOME.
    const [pwd, home, self] = (await text(where!.reference.stdout)).split('\n');
    expect(pwd).toMatch(new RegExp(`^${workDir}/slot-[01]/case$`));
    expect(home).toBe(pwd);
    expect(self).toMatch(new RegExp(`^${workDir}/programs/side-0/tool$`));
    // The same program as candidate matches everywhere; the bad one only where it differs.
    expect(result.cases.map((c) => c.candidates[0]!.comparison.verdict)).toEqual(Array(6).fill('match'));
    expect(result.cases.map((c) => c.candidates[1]!.comparison.verdict)).toEqual(['match', 'diverge', 'match', 'match', 'match', 'match']);
    // 3 sides × 2 slots, all removed once the run is over.
    expect(await containers(engine!, join(workDir, 'containers'))).toEqual([]);
  }, 120_000);

  it('isolates a case: no network, a read-only root, the image PATH, and the other side out of sight', async () => {
    const cases = await Promise.all([make({ argv: ['net'] }), make({ argv: ['root'] }), make({ argv: ['path'] }), make({ argv: ['see', ref.realPath] })]);
    const result = await runCases({ reference: bad, candidates: [], cases, store, sandbox: sandbox(), workDir: join(dir, 'isolated'), programName: 'tool', concurrency: 1 });
    const [net, root, path, see] = result.cases.map((c) => c.reference);
    // No route anywhere: the routing table has its header line only.
    expect((await text(net!.stdout)).trimEnd().split('\n')).toHaveLength(1);
    expect(root!.exit).not.toBe(0);
    expect(await text(root!.stderr)).toMatch(/Read-only file system/);
    expect(await text(path!.stdout)).toMatch(/^.*\/programs\/side-0:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\n$/);
    // The reference's program is on the host, but not mounted in the bad port's container.
    expect(see!.exit).not.toBe(0);
    expect(await text(see!.stderr)).toMatch(/No such file or directory/);
  }, 120_000);

  it('stops a case at its timeout and one that writes past the output cap, and the container keeps going', async () => {
    const cases = await Promise.all([make({ argv: ['sleep', '30'] }), make({ argv: ['big', '5000'] }), make({ argv: ['echo', 'after'] })]);
    const started = performance.now();
    const result = await runCases({ reference: ref, candidates: [], cases, store, sandbox: sandbox(), workDir: join(dir, 'limits'), programName: 'tool', concurrency: 1, timeoutMs: 1_000, outputCapBytes: 1_000 });
    expect(performance.now() - started).toBeLessThan(25_000);
    const [sleep, big, after] = result.cases.map((c) => c.reference);
    expect(sleep).toMatchObject({ timeout: true, exit: 143 });
    expect(await text(sleep!.stdout)).toBe('');
    expect(big!.timeout).toBe(false);
    expect((await store.get(big!.stdout)).length).toBe(1_000);
    expect(big!.exit).toBe(128 + 25); // SIGXFSZ
    expect(await text(after!.stdout)).toBe('after\n');
  }, 60_000);
});

/** The names of the containers a pool started in `dir` that are still there. */
async function containers(engine: string, dir: string): Promise<string[]> {
  const { stdout } = await exec(engine, ['ps', '-a', '--filter', `label=port-anything=${dir}`, '--format', '{{.Names}}']);
  return stdout.split('\n').filter((line) => line !== '').sort();
}

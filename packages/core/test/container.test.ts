import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { caseScript, ContainerError, ContainerPool, containerSpace, engineCpus, ensureImage, findContainerEngine, RUNNER_SCRIPT, RUNNER_TOOLS, shellQuote } from '../src/container.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { DEFAULT_OUTPUT_CAP_BYTES } from '../src/process-runner.js';
import { NormalizersSchema } from '../src/normalize.js';
import { resolveProgram, type ResolvedProgram } from '../src/program.js';
import { observeCase, runCases } from '../src/run-cases.js';
import { containerSandbox, sandboxCommand } from '../src/sandbox.js';
import { packTar, readTar } from '../src/tar.js';

const exec = promisify(execFile);

describe('container mode, without a container', () => {
  it('quotes any word for sh', async () => {
    const words = ['plain', "it's", 'a b', '$HOME `x` "y"', '\\n', ''];
    const { stdout } = await exec('sh', ['-c', `printf '%s\\n' ${words.map(shellQuote).join(' ')}`]);
    expect(stdout).toBe(words.map((w) => `${w}\n`).join(''));
  });

  it('writes a case script: its directory, a file size limit just over the cap, a clean environment, stdin', () => {
    const script = caseScript({ argv: ['tool', '-x', "it's"], cwd: '/w/slot-0/case', env: { HOME: '/w/slot-0/case', PATH: '/bin' }, stdin: Buffer.from('in') }, 1024, '/pa-runner/case/stdin');
    expect(script).toBe(
      [
        "cd '/w/slot-0/case' || exit 126",
        'ulimit -f 3',
        "exec env -i 'HOME=/w/slot-0/case' 'PATH=/bin' 'PWD=/w/slot-0/case' 'tool' '-x' 'it'\\''s' <'/pa-runner/case/stdin'",
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
  vanish) cd / && rm -rf "$OLDPWD" ;;
  plant)
    # Traps for the host: links out of the case directory, and a process left behind.
    ln -s "$2" link
    mkdir sub && ln -s "$2" sub/inner
    setsid sh -c 'sleep 2; touch /tmp/pa-late' plant >/dev/null 2>&1 &
    ;;
  late) ls /tmp/pa-late ;;
  stash)
    # State for whichever case comes next: in /tmp, /dev/shm, next to the case directory, the runner's tmpfs.
    echo s >/tmp/state; echo s >/tmp/.hidden; echo s >/dev/shm/state; echo s >../stash; echo s >/pa-runner/state
    # Also in directories it then makes read-only, and unreadable.
    for d in /tmp/ro /dev/shm/ro ../ro /tmp/none; do mkdir "$d" && echo s >"$d/f"; done
    chmod 555 /tmp/ro /dev/shm/ro ../ro; chmod 000 /tmp/none
    ;;
  peek) cat /tmp/state /tmp/.hidden /dev/shm/state ../stash /pa-runner/state /tmp/ro/f /dev/shm/ro/f ../ro/f /tmp/none/f 2>&1; ls -A /tmp /dev/shm .. ;;
  mounts) grep -E " (/tmp|$(dirname "$PWD")|/pa-runner) " /proc/mounts ;;
  forge)
    # An answer of its own on the runner's stdout, with an archive that climbs out of the directory.
    printf 'done %s 0 0 0 0 %s\n' "$3" "$(wc -c <"$2")" >"/proc/$PPID/fd/1"
    cat "$2" >"/proc/$PPID/fd/1"
    sleep 1
    ;;
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

  /** A pool with one session for the tool alone in a directory of its own, mounted read-only. */
  const single = async (name: string, image = IMAGE, base = dir) => {
    const bin = join(base, `${name}-bin`);
    mkdirSync(bin);
    const tool = join(bin, 'tool');
    writeFileSync(tool, TOOL('ref'));
    chmodSync(tool, 0o755);
    const pool = new ContainerPool({ setup: { kind: 'container', engine: engine!, image }, dir: join(dir, name) });
    const caseDir = join(base, `${name}-work`, 'slot-0', 'case');
    const proc = (...argv: string[]) => ({ argv: [tool, ...argv], cwd: caseDir, env: { PATH: '/usr/bin:/bin' } });
    return { pool, caseDir, proc, session: () => pool.session({ binDir: bin, args: [], readOnlyPaths: [bin] }, caseDir) };
  };

  it('never takes a quick case for a timed-out one, even with many containers busy', async () => {
    // A case can end before its watchdog has started; the runner once waited out the timeout then.
    const quick = await Promise.all(Array.from({ length: 320 }, (_, i) => make({ argv: ['status', String(i % 2)] })));
    const started = performance.now();
    const result = await runCases({ reference: ref, candidates: [], cases: quick, store, sandbox: sandbox(), workDir: join(dir, 'quick'), programName: 'tool', concurrency: 8, timeoutMs: 30_000 });
    expect(result.cases.filter((c) => c.reference.timeout)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it("says so when a case's directory can't be copied back, and the container keeps going", async () => {
    const { pool, caseDir, proc, session } = await single('copies');
    try {
      const s = await session();
      // The case removed its own directory.
      const vanished = await s.prepare(caseDir);
      await expect(vanished.run(proc('vanish'))).rejects.toThrow(/could not copy back the directory of a case [^\n]*:\n.*No such file/);
      await vanished.dispose();
      const fine = await s.prepare(caseDir);
      writeFileSync(join(fine.files, `${'f'.repeat(150)}.txt`), 'long name\n');
      const result = await fine.run(proc('cat', `${'f'.repeat(150)}.txt`));
      expect(result.stdout.toString()).toBe('long name\n');
      expect(readFileSync(join(result.result, `${'f'.repeat(150)}.txt`), 'utf8')).toBe('long name\n');
      await fine.dispose();
    } finally {
      await pool.close();
    }
  }, 60_000);

  it('writes nothing through links a case left, and kills what it left running', async () => {
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    const { pool, caseDir, proc, session } = await single('plant');
    try {
      const s = await session();
      const planter = await s.prepare(caseDir);
      const planted = await planter.run(proc('plant', victim));
      expect(planted.exit).toBe(0);
      // The links come back as links, pointing where the case said.
      expect(readlinkSync(join(planted.result, 'link'))).toBe(victim);
      expect(readlinkSync(join(planted.result, 'sub', 'inner'))).toBe(victim);
      await planter.dispose();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // What it left running was killed before it could do anything.
      const after = await s.prepare(caseDir);
      writeFileSync(join(after.files, 'payload.txt'), 'x');
      const late = await after.run(proc('late'));
      expect(late.stderr.toString()).toMatch(/No such file/);
      await after.dispose();
      expect(readdirSync(victim)).toEqual([]);
    } finally {
      await pool.close();
    }
  }, 60_000);

  it.each([IMAGE, 'alpine:3'])('starts each case of a session in %s as clean as the first: nothing left in /tmp, /dev/shm or beside its directory', async (image) => {
    await ensureImage(engine!, image);
    const { pool, caseDir, proc, session } = await single(`clean-${image.replace(/\W/g, '-')}`, image);
    try {
      const s = await session();
      const stash = await s.prepare(caseDir);
      expect((await stash.run(proc('stash'))).exit).toBe(0);
      await stash.dispose();
      const peek = await s.prepare(caseDir);
      const seen = await peek.run(proc('peek'));
      await peek.dispose();
      // Every cat fails; the listings show only the case directory itself.
      expect(seen.stdout.toString().match(/No such file/g)).toHaveLength(9);
      expect(seen.stdout.toString()).not.toMatch(/^s$/m);
      expect(seen.stdout.toString().split('\n').filter((l) => l !== '' && !/No such file|:$/.test(l)).sort()).toEqual(['case', ...wayIn(dir)].sort());
    } finally {
      await pool.close();
    }
  }, 60_000);

  it.each([IMAGE, 'alpine:3'])('starts each case in %s clean when the program and the case directory are inside /tmp, as on a Linux host', async (image) => {
    await ensureImage(engine!, image);
    // Their mounts then sit in the container's /tmp, and stay when the runner empties it. (In /tmp
    // already on a Linux host; the host's /tmp, not a container's own, when the tests run in one.)
    const base = mkdtempSync(join(wayIn(dir).length > 0 ? dir : '/tmp', 'pa-container-'));
    const { pool, caseDir, proc, session } = await single(`in-tmp-${image.replace(/\W/g, '-')}`, image, base);
    try {
      const s = await session();
      const stash = await s.prepare(caseDir);
      expect((await stash.run(proc('stash'))).exit).toBe(0);
      await stash.dispose();
      const peek = await s.prepare(caseDir);
      const seen = await peek.run(proc('peek'));
      await peek.dispose();
      expect(seen.stdout.toString().match(/No such file/g)).toHaveLength(9);
      expect(seen.stdout.toString()).not.toMatch(/^s$/m);
      // /tmp holds only the way to the mounts.
      expect(seen.stdout.toString().split('\n').filter((l) => l !== '' && !/No such file|:$/.test(l)).sort()).toEqual(['case', ...wayIn(base)].sort());
    } finally {
      await pool.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it('limits the tmpfs mounts, and refuses an answer larger than the room the runner has', async () => {
    const { pool, caseDir, proc, session } = await single('space');
    const { caseBytes, runnerBytes } = containerSpace(DEFAULT_OUTPUT_CAP_BYTES);
    try {
      const s = await session();
      const mounts = await s.prepare(caseDir);
      const lines = (await mounts.run(proc('mounts'))).stdout.toString().trim().split('\n');
      await mounts.dispose();
      const size = (mount: string) => lines.find((l) => l.split(' ')[1] === mount)?.match(/size=(\d+)k/)?.[1];
      expect([size('/tmp'), size(dirname(caseDir)), size('/pa-runner')].map(Number)).toEqual([caseBytes / 1024, caseBytes / 1024, Math.ceil(runnerBytes / 4096) * 4]);
    } finally {
      await pool.close();
    }
    // An engine whose runner announces more than that.
    const fake = join(dir, 'fake-engine');
    writeFileSync(fake, `#!/bin/sh\n[ "$1" = run ] || exit 0\necho ready\nread -r cmd nonce rest\necho "done $nonce 0 0 ${runnerBytes} 1 0"\nsleep 30\n`);
    chmodSync(fake, 0o755);
    const faked = new ContainerPool({ setup: { kind: 'container', engine: fake, image: IMAGE }, dir: join(dir, 'fake') });
    try {
      const s = await faked.session({ binDir: dir, args: [], readOnlyPaths: [] }, caseDir);
      const big = await s.prepare(caseDir);
      await expect(big.run(proc('echo', 'x'))).rejects.toThrow(new RegExp(`announced an answer of ${runnerBytes + 1} bytes, more than its ${runnerBytes} bytes of room`));
      await big.dispose();
    } finally {
      await faked.close();
    }
  }, 60_000);

  it('ends a session whose case wrote an answer of its own, and writes nothing outside its directory', async () => {
    const { pool, caseDir, proc, session } = await single('forge');
    try {
      const s = await session();
      const forger = await s.prepare(caseDir);
      writeFileSync(join(forger.files, 'evil.tar'), packTar([{ type: 'file', name: Buffer.from('../../../escaped'), data: Buffer.from('x') }]));
      // It can't know the nonce of its case, so it can only guess.
      await expect(forger.run(proc('forge', 'evil.tar', '0123456789abcdef'))).rejects.toThrow(/stopped answering/);
      await forger.dispose();
      expect(readdirSync(join(dir, 'forge'), { recursive: true }).filter((name) => String(name).endsWith('escaped'))).toEqual([]);
      const next = await s.prepare(caseDir);
      await expect(next.run(proc('echo', 'x'))).rejects.toThrow(/has stopped/);
      await next.dispose();
    } finally {
      await pool.close();
    }
  }, 60_000);

  // BusyBox's tools differ from GNU's (its head reads ahead, for one).
  it.each([IMAGE, 'alpine:3'])('runs the protocol in %s: one archive in, stdout, stderr and the case directory out, or what went wrong', async (image) => {
    await ensureImage(engine!, image);
    const child = spawn(engine!, ['run', '--rm', '-i', '--tmpfs', '/w', '--tmpfs', '/pa-runner', '--entrypoint', '/bin/sh', image, '-c', RUNNER_SCRIPT]);
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    const received = async (bytes: number) => {
      for (let i = 0; i < 300 && Buffer.concat(out).length < bytes; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const all = Buffer.concat(out);
      out.length = 0;
      return all;
    };
    const send = (entries: Parameters<typeof packTar>[0]) => {
      const archive = packTar(entries);
      child.stdin.write(`run n0nce 10 1 ${archive.length}\n`);
      child.stdin.write(archive);
    };
    const f = (name: string, data: string | Buffer) => ({ type: 'file' as const, name: Buffer.from(name), data: Buffer.from(data) });
    try {
      expect((await received(6)).toString()).toBe('ready\n');
      // 200 kB of stdin, more than one read of a pipe.
      const big = Buffer.alloc(200_000, 'y');
      send([f('dir', '/w/case'), f('cmd', 'cd /w/case && wc -c </pa-runner/case/stdin && printf oops >&2 && echo made >sub/out.txt\n'), f('stdin', big), { type: 'dir', name: Buffer.from('case') }, { type: 'dir', name: Buffer.from('case/sub') }, f('case/sub/in.txt', 'in')]);
      const head = 'done n0nce 0 0 7 4 ';
      let answer = await received(head.length + 11);
      const line = answer.subarray(0, answer.indexOf(0x0a)).toString();
      expect(line).toMatch(/^done n0nce 0 0 7 4 \d+$/);
      const tarBytes = Number(line.split(' ')[6]);
      answer = Buffer.concat([answer, await received(line.length + 1 + 11 + tarBytes - answer.length)]);
      const body = answer.subarray(line.length + 1);
      expect(body.subarray(0, 11).toString()).toBe('200000\noops');
      const names = readTar(body.subarray(11, 11 + tarBytes)).map((e) => `${e.type} ${e.name.toString()}`);
      expect(names.map((n) => n.replace(/\/$/, '')).sort()).toEqual(['dir .', 'dir ./sub', 'file ./sub/in.txt', 'file ./sub/out.txt']);
      // Not an archive: tar says why, and the runner takes the next case.
      const junk = Buffer.alloc(1024, 'x');
      child.stdin.write(`run n0nce 10 1 ${junk.length}\n`);
      child.stdin.write(junk);
      const error = (await received(20)).toString();
      expect(error).toMatch(/^error n0nce in \d+\n.*tar/s);
      // A case directory where none can be made.
      send([f('dir', '/no-such-dir/case'), f('cmd', 'true\n'), { type: 'dir', name: Buffer.from('case') }]);
      expect((await received(20)).toString()).toMatch(/^error n0nce in \d+\n.*(No such file|cannot)/s);
      send([f('dir', '/w/case'), f('cmd', 'echo still\n'), { type: 'dir', name: Buffer.from('case') }]);
      expect((await received(20)).toString()).toMatch(/^done n0nce 0 0 6 0 \d+\nstill\n/);
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, 60_000);

  it('says which tools an image lacks', async () => {
    const child = spawn(engine!, ['run', '--rm', '-i', '-e', 'PATH=/nowhere', '--entrypoint', '/bin/sh', IMAGE, '-c', RUNNER_SCRIPT]);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    expect((await lines.next()).value).toBe(`missing ${RUNNER_TOOLS.join(' ')}`);
    child.kill();
    // And a pool names the image and the tools.
    const tag = `port-anything-test-no-tar:${process.pid}`;
    const context = join(dir, 'no-tar');
    mkdirSync(context);
    writeFileSync(join(context, 'Dockerfile'), `FROM ${IMAGE}\nRUN rm /usr/bin/tar\n`);
    await exec(engine!, ['build', '-q', '-t', tag, context]);
    const { pool, session } = await single('no-tar-pool', tag);
    try {
      await expect(session()).rejects.toThrow(new RegExp(`The image ${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(sandbox.image\\) has no tar: `));
    } finally {
      await pool.close();
      await exec(engine!, ['rmi', '-f', tag]).catch(() => {});
    }
  }, 180_000);
});

/** What a container's /tmp keeps of the way to mounts in `dir`: its first directory there, if it is in /tmp. */
function wayIn(dir: string): string[] {
  return dir.startsWith('/tmp/') ? [dir.split('/')[2]!] : [];
}

/** The names of the containers a pool started in `dir` that are still there. */
async function containers(engine: string, dir: string): Promise<string[]> {
  const { stdout } = await exec(engine, ['ps', '-a', '--filter', `label=port-anything=${dir}`, '--format', '{{.Names}}']);
  return stdout.split('\n').filter((line) => line !== '').sort();
}

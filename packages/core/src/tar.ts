import { copyFile, constants, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';

/**
 * Just enough tar for container mode, where case files travel over a container's stdin and stdout:
 * `packTar` writes the GNU format (the `tar` of Debian, Alpine and most images reads it), and
 * `unpackTar` reads what GNU tar or BusyBox tar wrote, including GNU long names and pax headers.
 */

const BLOCK = 512;

/** One member of an archive. Names are bytes, as file names may not be UTF-8. */
export type TarEntry =
  | { type: 'file'; name: Buffer; data: Buffer }
  | { type: 'dir'; name: Buffer }
  | { type: 'symlink'; name: Buffer; target: Buffer }
  | { type: 'hardlink'; name: Buffer; target: Buffer };

/** Thrown for an archive that isn't well formed, or a member that would land outside the directory. */
export class TarError extends Error {
  override readonly name = 'TarError';
}

function header(name: Buffer, type: string, size: number, link: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(BLOCK);
  name.copy(h, 0, 0, 100);
  h.write(`${(type === '5' ? 0o755 : 0o644).toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  h.write(type, 156, 'ascii');
  link.copy(h, 157, 0, 100);
  h.write('ustar  \0', 257, 'ascii');
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** An archive of `entries`, in order; names (and link targets) over 100 bytes get GNU long-name members. */
export function packTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const long = (type: 'L' | 'K', value: Buffer) => {
    if (value.length < 100) return;
    const data = Buffer.concat([value, Buffer.alloc(1)]);
    parts.push(header(Buffer.from('././@LongLink'), type, data.length), data, padding(data.length));
  };
  for (const entry of entries) {
    const name = entry.type === 'dir' && !entry.name.toString('latin1').endsWith('/') ? Buffer.concat([entry.name, Buffer.from('/')]) : entry.name;
    long('L', name);
    if (entry.type === 'file') {
      parts.push(header(name, '0', entry.data.length), entry.data, padding(entry.data.length));
    } else if (entry.type === 'dir') {
      parts.push(header(name, '5', 0));
    } else {
      long('K', entry.target);
      parts.push(header(name, entry.type === 'symlink' ? '2' : '1', 0, entry.target));
    }
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

/** The directories, regular files and symlinks under `dir`, as members under `prefix` (parents first). */
export async function treeEntries(dir: string, prefix: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [{ type: 'dir', name: Buffer.from(prefix) }];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = `${dir}/${item.name}`;
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) entries.push(...(await treeEntries(path, name)));
    else if (item.isFile()) entries.push({ type: 'file', name: Buffer.from(name), data: await readFile(path) });
    else if (item.isSymbolicLink()) throw new TarError(`${path} is a symlink; case files are regular files.`);
  }
  return entries;
}

/** A NUL-terminated field, as bytes. */
function field(block: Buffer, start: number, length: number): Buffer {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return end === -1 ? raw : raw.subarray(0, end);
}

/** A numeric field: octal digits, or GNU's base-256 when the high bit of the first byte is set. */
function number(block: Buffer, start: number, length: number): number {
  const raw = block.subarray(start, start + length);
  if (raw[0]! & 0x80) {
    let value = raw[0]! & 0x7f;
    for (const byte of raw.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = raw.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`Bad number in a tar header: ${JSON.stringify(text)}.`);
  return parseInt(text, 8);
}

/** The members of an archive, with long names and pax paths applied. Device files and FIFOs are left out. */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: Buffer | undefined;
  let longLink: Buffer | undefined;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) return entries;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (sum !== number(block, 148, 8)) throw new TarError(`Bad checksum in the tar header at byte ${offset}.`);
    const type = String.fromCharCode(block[156]!);
    const size = number(block, 124, 12);
    const start = offset + BLOCK;
    if (start + size > archive.length) throw new TarError('The tar archive ends inside a member.');
    const data = archive.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') longName = field(data, 0, data.length);
    else if (type === 'K') longLink = field(data, 0, data.length);
    else if (type === 'x') {
      for (const [key, value] of paxRecords(data)) {
        if (key === 'path') longName = value;
        if (key === 'linkpath') longLink = value;
      }
    } else if (type !== 'g') {
      const prefix = block.subarray(257, 263).toString('latin1') === 'ustar\x0000' ? field(block, 345, 155) : Buffer.alloc(0);
      const name = longName ?? (prefix.length > 0 ? Buffer.concat([prefix, Buffer.from('/'), field(block, 0, 100)]) : field(block, 0, 100));
      const target = longLink ?? field(block, 157, 100);
      longName = longLink = undefined;
      if (type === '0' || type === '\0' || type === '7') entries.push({ type: 'file', name, data: Buffer.from(data) });
      else if (type === '5') entries.push({ type: 'dir', name });
      else if (type === '2') entries.push({ type: 'symlink', name, target: Buffer.from(target) });
      else if (type === '1') entries.push({ type: 'hardlink', name, target: Buffer.from(target) });
      else if (type !== '3' && type !== '4' && type !== '6') throw new TarError(`Unsupported tar member type ${JSON.stringify(type)}.`);
    }
  }
  throw new TarError('The tar archive has no end marker.');
}

function* paxRecords(data: Buffer): Generator<[string, Buffer]> {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = space === -1 ? NaN : Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw new TarError('Bad pax header record.');
    const record = data.subarray(space + 1, offset + length - 1);
    const eq = record.indexOf(0x3d);
    if (eq !== -1) yield [record.subarray(0, eq).toString('utf8'), Buffer.from(record.subarray(eq + 1))];
    offset += length;
  }
}

/** The components of a member's name, without `./`; refuses absolute names, `..` and empty names. */
function components(name: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= name.length; i++) {
    if (i < name.length && name[i] !== 0x2f) continue;
    const part = name.subarray(start, i);
    start = i + 1;
    if (part.length === 0 && i === 0) throw new TarError(`The tar member ${JSON.stringify(name.toString('utf8'))} has an absolute name.`);
    if (part.length === 0 || (part.length === 1 && part[0] === 0x2e)) continue;
    if (part.length === 2 && part[0] === 0x2e && part[1] === 0x2e) throw new TarError(`The tar member ${JSON.stringify(name.toString('utf8'))} goes up a directory.`);
    parts.push(part);
  }
  return parts;
}

/**
 * Writes the members of `archive` into `dest`, which it creates and which must not exist. Nothing
 * lands outside it: names are relative with no `..`, every parent must be a directory this archive
 * made (so nothing is written through a symlink it made), nothing is overwritten, and a hard link
 * may only copy a regular file written earlier from the same archive. Symlinks are made as they are,
 * never followed.
 */
export async function unpackTar(archive: Buffer, dest: string): Promise<void> {
  await mkdir(dest);
  const root = Buffer.from(dest);
  const dirs = new Set<string>(['']);
  const files = new Map<string, Buffer>();
  for (const entry of readTar(archive)) {
    const parts = components(entry.name);
    if (parts.length === 0) {
      if (entry.type === 'dir') continue;
      throw new TarError('A tar member that is not a directory names the top directory.');
    }
    const key = (list: Buffer[]) => Buffer.concat(list.flatMap((p) => [Buffer.from('/'), p])).toString('latin1');
    const parent = key(parts.slice(0, -1));
    if (!dirs.has(parent)) throw new TarError(`The tar member ${JSON.stringify(entry.name.toString('utf8'))} is not in a directory of the archive.`);
    const rel = key(parts);
    const path = Buffer.concat([root, Buffer.from(rel, 'latin1')]);
    if (entry.type === 'dir') {
      if (dirs.has(rel)) continue;
      await mkdir(path, { mode: 0o755 });
      dirs.add(rel);
    } else if (entry.type === 'file') {
      await writeFile(path, entry.data, { flag: 'wx', mode: 0o644 });
      files.set(rel, path);
    } else if (entry.type === 'symlink') {
      await symlink(entry.target, path);
    } else {
      const source = files.get(key(components(entry.target)));
      if (source === undefined || !(await lstat(source)).isFile()) {
        throw new TarError(`The tar member ${JSON.stringify(entry.name.toString('utf8'))} links to a file the archive didn't write.`);
      }
      await copyFile(source, path, constants.COPYFILE_EXCL);
      files.set(rel, path);
    }
  }
}

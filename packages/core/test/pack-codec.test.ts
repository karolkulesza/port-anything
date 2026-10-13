import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PACK_CODEC, compressPack, decompressPack } from '../src/pack-codec.js';

// Every zstd frame starts with this magic number (RFC 8878, section 3.1.1).
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

describe('pack codec', () => {
  it('uses zstd', () => {
    expect(PACK_CODEC).toBe('zstd');
  });

  it('round-trips a compressible buffer and shrinks it', async () => {
    const input = Buffer.from('{"argv":["wc","-l"],"stdout":"42\\n"}\n'.repeat(2000));
    const packed = await compressPack(input);
    expect(packed.subarray(0, 4)).toEqual(ZSTD_MAGIC);
    expect(packed.length).toBeLessThan(input.length / 10);
    expect(await decompressPack(packed)).toEqual(input);
  });

  it('round-trips random bytes and an empty buffer', async () => {
    for (const input of [randomBytes(64 * 1024), Buffer.alloc(0)]) {
      expect(await decompressPack(await compressPack(input))).toEqual(input);
    }
  });

  it('accepts a Uint8Array', async () => {
    const input = new TextEncoder().encode('héllo, wörld');
    expect(new Uint8Array(await decompressPack(await compressPack(input)))).toEqual(input);
  });

  it('writes a single frame with a content checksum', async () => {
    const packed = await compressPack(Buffer.from('abc\n'.repeat(1000)));
    // Frame_Header_Descriptor bit 2 is Content_Checksum_flag (RFC 8878, section 3.1.1.1.1).
    expect(packed[4]! & 0b100).toBe(0b100);
  });

  it('rejects data that is not zstd', async () => {
    await expect(decompressPack(Buffer.from('not a pack'))).rejects.toThrow(/not a zstd frame/);
  });

  it('rejects a truncated pack', async () => {
    const packed = await compressPack(randomBytes(300 * 1024));
    for (const length of [0, 1, 4, 5, 100, packed.length >> 1, packed.length - 4, packed.length - 1]) {
      await expect(decompressPack(packed.subarray(0, length)), `cut to ${length} bytes`).rejects.toThrow(
        /truncated|not a zstd frame/,
      );
    }
  });

  it('rejects trailing bytes after the frame', async () => {
    const packed = await compressPack(Buffer.from('abc'));
    await expect(decompressPack(Buffer.concat([packed, packed]))).rejects.toThrow(/trailing/);
  });

  it('rejects a pack whose checksum does not match', async () => {
    const packed = Buffer.from(await compressPack(Buffer.from('abc\n'.repeat(1000))));
    packed[packed.length - 1]! ^= 0xff;
    await expect(decompressPack(packed)).rejects.toMatchObject({ code: 'ZSTD_error_checksum_wrong' });
  });

  it('explains the Node requirement when zlib has no zstd', async () => {
    const original = zlib.zstdCompress;
    Object.assign(zlib, { zstdCompress: undefined });
    try {
      await expect(compressPack(Buffer.from('x'))).rejects.toThrow(/Node 22\.15 or later/);
    } finally {
      Object.assign(zlib, { zstdCompress: original });
    }
  });
});

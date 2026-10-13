import { promisify } from 'node:util';
import zlib from 'node:zlib';

/** Codec of the corpus pack (`corpus.pack.zst`): zlib's built-in zstd, so no native addon is needed. */
export const PACK_CODEC = 'zstd';

// Looked up on first use rather than imported by name, so loading this package on a Node without
// zstd (before 22.15) still works and only pack operations fail, with a clear message.
function zstd() {
  if (typeof zlib.zstdCompress !== 'function') {
    throw new Error(`Corpus packs need zstd from Node 22.15 or later; this is Node ${process.version}.`);
  }
  return { compress: promisify(zlib.zstdCompress), decompress: promisify(zlib.zstdDecompress) };
}

/** Compresses a corpus pack into a single zstd frame. */
export async function compressPack(data: Uint8Array, level = 19): Promise<Buffer> {
  return zstd().compress(data, {
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: level,
      [zlib.constants.ZSTD_c_checksumFlag]: 1,
    },
  });
}

/**
 * Decompresses a corpus pack. Rejects unless the data is exactly one complete zstd frame whose
 * checksum and content size match: Node's decoder returns partial output for a truncated frame.
 */
export async function decompressPack(data: Uint8Array): Promise<Buffer> {
  const { decompress } = zstd();
  const contentSize = checkFrame(data);
  const output = await decompress(data);
  if (contentSize !== undefined && BigInt(output.length) !== contentSize) {
    throw new Error(`Corpus pack is damaged: expected ${contentSize} bytes, got ${output.length}.`);
  }
  return output;
}

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Walks the frame layout (RFC 8878, section 3.1.1) without decoding: header, every block up to the
 * one marked last, then the 4-byte checksum. Returns Frame_Content_Size when the header has one.
 */
function checkFrame(data: Uint8Array): bigint | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const truncated = () => new Error('Corpus pack is truncated: the zstd frame ends early.');
  if (data.length < 4 || view.getUint32(0, true) !== ZSTD_MAGIC) {
    throw new Error('Corpus pack is not a zstd frame.');
  }
  if (data.length < 5) throw truncated();
  const descriptor = data[4]!;
  const sizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictIdSize = [0, 1, 2, 4][descriptor & 3]!;
  const contentSizeBytes = [singleSegment, 2, 4, 8][sizeFlag]!;
  let pos = 5 + (singleSegment ? 0 : 1) + dictIdSize;
  if (pos + contentSizeBytes > data.length) throw truncated();

  let contentSize: bigint | undefined;
  if (contentSizeBytes === 1) contentSize = BigInt(data[pos]!);
  else if (contentSizeBytes === 2) contentSize = BigInt(view.getUint16(pos, true) + 256);
  else if (contentSizeBytes === 4) contentSize = BigInt(view.getUint32(pos, true));
  else if (contentSizeBytes === 8) contentSize = view.getBigUint64(pos, true);
  pos += contentSizeBytes;

  for (let last = false; !last; ) {
    if (pos + 3 > data.length) throw truncated();
    const header = data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16);
    last = (header & 1) === 1;
    const type = (header >> 1) & 3;
    if (type === 3) throw new Error('Corpus pack is damaged: reserved zstd block type.');
    pos += 3 + (type === 1 ? 1 : header >>> 3); // an RLE block stores a single byte
    if (pos > data.length) throw truncated();
  }
  if (!hasChecksum) throw new Error('Corpus pack is damaged: the zstd frame has no checksum.');
  pos += 4;
  if (pos > data.length) throw truncated();
  if (pos < data.length) throw new Error('Corpus pack is damaged: trailing bytes after the zstd frame.');
  return contentSize;
}

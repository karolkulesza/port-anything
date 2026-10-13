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

/** Decompresses a corpus pack; rejects if the data is not valid zstd or fails its checksum. */
export async function decompressPack(data: Uint8Array): Promise<Buffer> {
  return zstd().decompress(data);
}

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The README demo (docs/demo/compare.gif, recorded from docs/demo/compare.tape) must stay small
// enough to load quickly and short enough to watch to the end.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const GIF = 'docs/demo/compare.gif';

/** Total play time of a GIF in seconds: the sum of its frame delays (1/100 s each). */
function gifDuration(bytes: Uint8Array): number {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (!/^GIF8[79]a$/.test(ascii(0, 6))) throw new Error('not a GIF');
  const colorTable = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  const end = (at: number) => {
    if (at >= bytes.length) throw new Error('truncated GIF');
    return bytes[at]!;
  };
  const skipSubBlocks = (at: number) => {
    while (end(at) !== 0) at += bytes[at]! + 1;
    return at + 1;
  };
  let at = 13 + colorTable(bytes[10]!);
  let centiseconds = 0;
  for (;;) {
    const block = end(at);
    if (block === 0x3b) return centiseconds / 100; // trailer
    if (block === 0x21) {
      if (bytes[at + 1] === 0xf9) centiseconds += bytes[at + 4]! | (bytes[at + 5]! << 8); // graphic control
      at = skipSubBlocks(at + 2);
    } else if (block === 0x2c) {
      at = skipSubBlocks(at + 10 + colorTable(bytes[at + 9]!) + 1); // image: descriptor, LZW code size, data
    } else {
      throw new Error(`unexpected GIF block 0x${block.toString(16)} at ${at}`);
    }
  }
}

describe('README demo GIF', () => {
  it('is under 5 MB', () => {
    expect(statSync(root + GIF).size).toBeLessThan(5 * 1024 * 1024);
  });

  it('plays in under 60 seconds', () => {
    const seconds = gifDuration(readFileSync(root + GIF));
    expect(seconds).toBeGreaterThan(5);
    expect(seconds).toBeLessThan(60);
  });

  it('is shown in the README', () => {
    expect(readFileSync(root + 'README.md', 'utf8')).toContain(`](${GIF})`);
  });
});

describe('gifDuration', () => {
  // 1×1 GIF89a, two frames of 0.5 s and 1.25 s, no global color table, local tables of 2 colors.
  const frame = (delay: number) => [
    0x21, 0xf9, 0x04, 0x00, delay & 0xff, delay >> 8, 0x00, 0x00,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 0, 0, 0, 255, 255, 255,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ];
  const gif = Uint8Array.from([
    ...Buffer.from('GIF89a'), 1, 0, 1, 0, 0x00, 0, 0,
    0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00,
    ...frame(50), ...frame(125),
    0x3b,
  ]);

  it('adds up the frame delays', () => {
    expect(gifDuration(gif)).toBe(1.75);
  });

  it('rejects a GIF cut off mid-frame', () => {
    expect(() => gifDuration(gif.subarray(0, gif.length - 6))).toThrow('truncated GIF');
    expect(() => gifDuration(gif.subarray(0, gif.length - 1))).toThrow('truncated GIF');
  });

  it('rejects other files', () => {
    expect(() => gifDuration(Buffer.from('\x89PNG\r\n'))).toThrow('not a GIF');
  });
});

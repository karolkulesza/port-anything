import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The corpus pack uses zlib's built-in zstd, which Node 22 has since 22.15.0.
const MIN_NODE = '>=22.15';

const root = join(import.meta.dirname, '../../..');
const manifests = [
  join(root, 'package.json'),
  ...readdirSync(join(root, 'packages')).map((dir) => join(root, 'packages', dir, 'package.json')),
];

describe('engines.node', () => {
  it.each(manifests.map((path) => [path.slice(root.length + 1), path]))('%s requires the minimum Node', (_, path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { engines?: { node?: string } };
    expect(manifest.engines?.node).toBe(MIN_NODE);
  });
});

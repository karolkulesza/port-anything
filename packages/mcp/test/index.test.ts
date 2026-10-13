import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@port-anything/mcp', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@port-anything/mcp');
  });
});

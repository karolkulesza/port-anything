import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@port-anything/core', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@port-anything/core');
  });
});

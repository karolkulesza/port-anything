import { defineConfig } from 'tsup';
import { base } from '../../tsup.base.js';

export default defineConfig({ ...base, entry: ['src/index.ts', 'src/bin.ts'] });

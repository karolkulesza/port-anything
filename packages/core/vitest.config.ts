import { defineConfig } from 'vitest/config';

// Vitest 5 hides console output from passing tests; some tests report measurements (such as the
// token-mutation parse rate) that should show in every run.
export default defineConfig({ test: { silent: false } });

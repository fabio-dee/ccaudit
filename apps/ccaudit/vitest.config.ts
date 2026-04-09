import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __CCAUDIT_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    watch: false,
    passWithNoTests: true,
    includeSource: ['src/**/*.{js,ts}'],
    globals: true,
  },
});

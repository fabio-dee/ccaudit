import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    passWithNoTests: true,
    includeSource: ['src/**/*.{js,ts}'],
    globals: true,
  },
});

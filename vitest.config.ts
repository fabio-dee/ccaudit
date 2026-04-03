import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    passWithNoTests: true,
    watch: false,
    reporters: isCI ? ['default', 'github-actions'] : ['default'],
    projects: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
  },
});

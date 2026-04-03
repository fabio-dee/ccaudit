import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/*.ts', '!./src/**/*.test.ts', '!./src/_*.ts'],
  outDir: 'dist',
  format: 'esm',
  clean: true,
  sourcemap: false,
  minify: 'dce-only',
  treeshake: true,
  publint: true,
  unused: true,
  nodeProtocol: true,
  define: {
    'import.meta.vitest': 'undefined',
  },
});

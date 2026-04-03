import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/*.ts', '!./src/**/*.test.ts', '!./src/_*.ts'],
  outDir: 'dist',
  format: 'esm',
  clean: true,
  sourcemap: false,
  minify: 'dce-only',
  treeshake: true,
  nodeProtocol: true,
  outputOptions: {
    entryFileNames: '[name].js',
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
});

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

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
    __CCAUDIT_VERSION__: JSON.stringify(pkg.version),
  },
});

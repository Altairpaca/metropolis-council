/** Vite config for the playable web build (run from the repo root). */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '.');

export default defineConfig({
  root,
  base: './',
  resolve: {
    alias: {
      '@metropolis/core': resolve(here, '../../packages/core/src/index.ts'),
      '@metropolis/council': resolve(here, '../../packages/council/src/index.ts'),
      '@metropolis/render': resolve(here, '../../packages/render/src/index.ts'),
      '@metropolis/bench': resolve(here, '../../packages/bench/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(here, '../../dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1800,
  },
  server: { port: 5173, host: '127.0.0.1' },
});

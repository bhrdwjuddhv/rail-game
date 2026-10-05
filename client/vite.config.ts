import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  // data/ lives at the repo root, shared by client and server
  server: { fs: { allow: ['..'] } },
  test: { name: 'client', environment: 'node', include: ['test/**/*.test.ts'] },
});

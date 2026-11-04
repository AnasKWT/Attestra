import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/ai.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['@langchain/core', 'zod'],
});

import { defineConfig } from 'tsup';

// Bundle the CLI and @localmax/core into one ESM file. Runtime deps stay external
// so npm installs them; the catalog JSON is inlined.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: ['@localmax/core'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
});

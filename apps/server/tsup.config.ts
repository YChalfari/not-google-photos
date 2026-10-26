import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'src/cli/migrate.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The shared contract ships as TypeScript source, so bundle it; everything else stays external.
  noExternal: ['@ngp/shared'],
});

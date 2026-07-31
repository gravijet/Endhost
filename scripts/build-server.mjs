// Bundle the TypeScript backend to a single CJS file. node_modules stay external
// (dockerode/express do dynamic requires that don't survive bundling), so they are
// required at runtime from node_modules next to dist/.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist/server', { recursive: true, force: true });

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

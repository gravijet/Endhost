// Bundle the browser TypeScript into ES-module bundles under public/assets/js.
// One entry per page graph, so a page loads only its own code.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('public/assets/js', { recursive: true, force: true });

await build({
  entryPoints: {
    home: 'src/web/home.ts',
    dashboard: 'src/web/dashboard.ts',
  },
  outdir: 'public/assets/js',
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  splitting: true,
  sourcemap: true,
  minify: true,
  logLevel: 'info',
});

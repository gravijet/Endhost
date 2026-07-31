// Build the two first-party network plugins (the Paper lobby plugin and the Velocity proxy
// plugin) with Maven and drop the jars into plugins-dist/, which the panel installs into the
// lobby and proxy volumes. Maven is slow and the jars rarely change, so this is kept out of
// the fast `npm run build`; run `npm run build:plugins` when the Java changes. The built jars
// are tracked in plugins-dist/ so a deploy never has to run Maven.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'plugins-src';
const OUT = 'plugins-dist';

const jars = [
  { module: 'lobby', file: 'EndhostLobby.jar' },
  { module: 'proxy', file: 'EndhostProxy.jar' },
];

console.log('[plugins] building with Maven…');
execFileSync('mvn', ['-q', '-f', join(SRC, 'pom.xml'), '-DskipTests', 'clean', 'package'], {
  stdio: 'inherit',
});

mkdirSync(OUT, { recursive: true });
for (const { module, file } of jars) {
  copyFileSync(join(SRC, module, 'target', file), join(OUT, file));
  console.log(`[plugins] ${file} -> ${OUT}/${file}`);
}
console.log('[plugins] done.');

/**
 * Bundles the bot to a single file, dist/bot.js. That file plus
 * node_modules (production dependencies only) is the whole install.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/bot.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // discord.js pulls in optional native bits it can live without; leaving the
  // dependencies external keeps the bundle honest and node_modules beside it.
  packages: 'external',
  logLevel: 'info',
});

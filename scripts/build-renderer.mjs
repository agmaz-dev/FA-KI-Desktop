import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'renderer');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'renderer.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(out, 'renderer.js'),
  minify: true,
  logLevel: 'info',
});

fs.copyFileSync(path.join(root, 'src', 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(root, 'src', 'styles.css'), path.join(out, 'styles.css'));
console.log('Renderer gebaut:', out);

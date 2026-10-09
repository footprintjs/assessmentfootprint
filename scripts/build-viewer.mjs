import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.slice(2).includes('--check');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['client/replay.tsx'],
  outfile: 'web/assets/replay.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
});
const expected = new Set(['replay.js', 'replay.css'].map(name => resolve(root, 'web/assets', name)));
for (const output of result.outputFiles) {
  if (!expected.delete(output.path)) throw new Error('Unexpected viewer build output.');
  if (check) {
    if (!existsSync(output.path) || !readFileSync(output.path).equals(Buffer.from(output.contents))) throw new Error('The committed replay bundle is missing or out of date. Run npm run build:viewer.');
  } else {
    mkdirSync(dirname(output.path), { recursive: true });
    writeFileSync(output.path, output.contents);
  }
  process.stdout.write(`${check ? 'Verified' : 'Built'} ${output.path.slice(root.length + 1)} (${output.contents.length.toLocaleString('en-US')} bytes)\n`);
}
if (expected.size) throw new Error('The viewer build must include its JavaScript and stylesheet.');

import {defineConfig} from 'vitest/config';
import {readFile} from 'node:fs/promises';
// @ts-expect-error Checked adapter for the pinned upstream D2 runtime.
import {patchD2} from './scripts/d2-webkit.mjs';
export default defineConfig({
  clearScreen: false,
  server: {port: 5173, strictPort: true},
  plugins: [{name:'d2-webkit', enforce:'pre', async load(id) {
    if (/\/node_modules\/@d2lang\/d2\/dist\/browser\/index\.js$/.test(id))
      return patchD2(await readFile(id,'utf8'));
  }}],
  optimizeDeps: {exclude:['@d2lang/d2','loro-crdt']},
  build: {target:'safari18'},
  test: {environment:'jsdom', include:['tests/**/*.test.ts','src/**/*.test.tsx']}
});

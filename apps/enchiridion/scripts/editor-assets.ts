import { cp, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const target = new URL('website/public/diagram-assets/', root);
await mkdir(target, { recursive: true });
await cp(new URL('website/node_modules/@excalidraw/excalidraw/dist/prod/fonts/', root), new URL('fonts/', target), { recursive: true });
console.log('Local Excalidraw font assets prepared.');

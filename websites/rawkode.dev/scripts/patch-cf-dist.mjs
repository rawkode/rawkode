#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const adapterPath = join('dist', '_worker.js', '_@astrojs-ssr-adapter.mjs');

// No-op: kept for backward compatibility. The build now targets
// src/_worker.ts directly as the workerEntryPoint, so this patch is
// unnecessary and intentionally disabled.
if (existsSync(adapterPath)) {
  console.log('[patch-cf-dist] noop (workerEntryPoint points to src/_worker.ts)');
} else {
  console.log('[patch-cf-dist] noop');
}

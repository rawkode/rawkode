// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import alteran from '@alteran/astro';

export default defineConfig({
  // Use advanced mode and point the worker entry at our local
  // src/_worker.ts, which calls createPdsFetchHandler (enables WS).
  adapter: cloudflare({
    mode: 'advanced',
    imageService: 'custom',
    workerEntryPoint: {
      path: './src/_worker.ts',
      namedExports: ['Sequencer'],
    },
  }),

  // serverEntry is redundant when workerEntryPoint.path is set,
  // but keep it for local preview parity.
  build: { serverEntry: 'src/_worker.ts' },
  integrations: [
    alteran({
      includeRootEndpoint: true,
      debugRoutes: process.env.NODE_ENV !== 'production',
    }),
  ],
});

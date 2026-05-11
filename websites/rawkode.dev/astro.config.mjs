import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import alteran from '@alteran/astro';

export default defineConfig({
  site: 'https://rawkode.dev',
  adapter: cloudflare({ mode: 'advanced', imageService: 'cloudflare' }),
  integrations: [
    alteran({
      debugRoutes: false,
      includeRootEndpoint: false,
    }),
  ],
});

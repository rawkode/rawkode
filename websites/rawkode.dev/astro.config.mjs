import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import alteran from '@alteran/astro';
import expressiveCode from 'astro-expressive-code';

export default defineConfig({
  site: 'https://rawkode.dev',
  adapter: cloudflare({ mode: 'advanced', imageService: 'cloudflare' }),
  integrations: [
    expressiveCode({
      // Match the site palette: Rosé Pine Dawn (light) + Catppuccin Frappé (dark).
      themes: ['rose-pine-dawn', 'catppuccin-frappe'],
      // Selector that matches our explicit theme override.
      themeCssSelector: (theme) => `[data-theme='${theme.name === 'rose-pine-dawn' ? 'light' : 'dark'}']`,
      // Let the OS preference drive the theme when there's no override — same
      // strategy as the rest of the design system.
      useDarkModeMediaQuery: true,
      styleOverrides: {
        borderRadius: 'var(--radii-md)',
        codeFontFamily: 'var(--fonts-mono)',
        uiFontFamily: 'var(--fonts-sans)',
      },
    }),
    alteran({
      debugRoutes: false,
      includeRootEndpoint: false,
    }),
  ],
});

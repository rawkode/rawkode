import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  jsxFramework: 'vue',
  include: ['./src/**/*.{js,jsx,ts,tsx,vue,astro}'],
  exclude: [],
  outdir: 'styled-system',
  theme: {
    extend: {
      tokens: {
        colors: {
          canvas: { value: '#f2f4f7' },
          panel: { value: '#ffffff' },
          ink: { value: '#111827' },
          quiet: { value: '#6b7280' },
          accent: { value: '#0f766e' },
          accentSoft: { value: '#ccfbf1' },
          warning: { value: '#b45309' },
          warningSoft: { value: '#fef3c7' },
        },
      },
      semanticTokens: {
        colors: {
          bg: { value: '{colors.canvas}' },
          surface: { value: '{colors.panel}' },
          text: { value: '{colors.ink}' },
          muted: { value: '{colors.quiet}' },
          primary: { value: '{colors.accent}' },
        },
      },
    },
  },
});

import { defineConfig } from '@pandacss/dev';

/**
 * Design system for rawkode.dev.
 *
 * The site is dark-first and mobile-first. Rosé Pine drives the primary
 * palette, with a restrained light variant kept for explicit user overrides.
 * Theme reactivity still uses the existing `[data-theme]` contract.
 */
export default defineConfig({
  preflight: true,
  include: [
    './src/**/*.{astro,ts,tsx,js,jsx,md,mdx}',
  ],
  exclude: [],
  outdir: 'styled-system',
  hash: false,
  minify: true,

  theme: {
    extend: {
      tokens: {
        fonts: {
          sans: { value: "'Figtree Variable', 'Figtree', system-ui, sans-serif" },
          mono: { value: "'SFMono-Regular', 'Cascadia Code', 'Source Code Pro', ui-monospace, Menlo, monospace" },
        },

        spacing: {
          '1': { value: '0.25rem' },
          '2': { value: '0.5rem' },
          '3': { value: '0.75rem' },
          '4': { value: '1rem' },
          '5': { value: '1.25rem' },
          '6': { value: '1.5rem' },
          '8': { value: '2rem' },
          '10': { value: '2.5rem' },
          '12': { value: '3rem' },
          '16': { value: '4rem' },
          '20': { value: '5rem' },
          '24': { value: '6rem' },
          '32': { value: '8rem' },
        },

        radii: {
          xs: { value: '4px' },
          sm: { value: '6px' },
          md: { value: '8px' },
          lg: { value: '10px' },
          xl: { value: '14px' },
          full: { value: '9999px' },
        },

        durations: {
          fast: { value: '120ms' },
          normal: { value: '240ms' },
          slow: { value: '420ms' },
        },

        easings: {
          'out-expo': { value: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          'in-out': { value: 'cubic-bezier(0.65, 0, 0.35, 1)' },
        },

        zIndex: {
          base: { value: '0' },
          raised: { value: '10' },
          sticky: { value: '100' },
          modal: { value: '400' },
          toast: { value: '500' },
          tooltip: { value: '600' },
        },

        colors: {
          rosePine: {
            base: { value: '#191724' },
            surface: { value: '#1f1d2e' },
            overlay: { value: '#26233a' },
            muted: { value: '#6e6a86' },
            subtle: { value: '#908caa' },
            text: { value: '#e0def4' },
            love: { value: '#eb6f92' },
            gold: { value: '#f6c177' },
            rose: { value: '#ebbcba' },
            pine: { value: '#31748f' },
            foam: { value: '#9ccfd8' },
            iris: { value: '#c4a7e7' },
            highlightLow: { value: '#21202e' },
            highlightMed: { value: '#403d52' },
            highlightHigh: { value: '#524f67' },
          },

          rosePineDawn: {
            base: { value: '#f8f7fb' },
            surface: { value: '#ffffff' },
            overlay: { value: '#f0eef6' },
            muted: { value: '#797593' },
            subtle: { value: '#6e6a86' },
            text: { value: '#232136' },
            love: { value: '#b4637a' },
            gold: { value: '#ea9d34' },
            rose: { value: '#d7827e' },
            pine: { value: '#286983' },
            foam: { value: '#56949f' },
            iris: { value: '#907aa9' },
            highlightLow: { value: '#f1eff7' },
            highlightMed: { value: '#ddd9ea' },
            highlightHigh: { value: '#cecacd' },
          },
        },
      },

      semanticTokens: {
        colors: {
          surface: {
            '1':       { value: 'light-dark(#f8f7fb, #191724)' },
            '2':       { value: 'light-dark(#ffffff, #1f1d2e)' },
            '3':       { value: 'light-dark(#f0eef6, #26233a)' },
            glass:     { value: 'light-dark(rgb(255 255 255 / 0.72), rgb(38 35 58 / 0.64))' },
            raised:    { value: 'light-dark(rgb(255 255 255 / 0.86), rgb(44 40 66 / 0.72))' },
            invert:    { value: 'light-dark(#191724, #ffffff)' },
          },

          text: {
            primary:   { value: 'light-dark(#232136, #e0def4)' },
            secondary: { value: 'light-dark(#6e6a86, #908caa)' },
            tertiary:  { value: 'light-dark(#797593, #6e6a86)' },
            invert:    { value: 'light-dark(#ffffff, #191724)' },
          },

          accent: {
            DEFAULT: { value: 'light-dark(#907aa9, #c4a7e7)' },
            hover:   { value: 'light-dark(#286983, #9ccfd8)' },
            muted:   { value: 'light-dark(#f1eff7, #21202e)' },
            soft:    { value: 'light-dark(rgb(144 122 169 / 0.16), rgb(196 167 231 / 0.18))' },
            cyan:    { value: 'light-dark(#56949f, #9ccfd8)' },
            gold:    { value: 'light-dark(#ea9d34, #f6c177)' },
            rose:    { value: 'light-dark(#d7827e, #ebbcba)' },
            success: { value: 'light-dark(#56949f, #6bd98f)' },
          },

          border: {
            subtle:  { value: 'light-dark(#ddd9ea, rgb(224 222 244 / 0.16))' },
            DEFAULT: { value: 'light-dark(#cecacd, rgb(224 222 244 / 0.24))' },
            strong:  { value: 'light-dark(#6e6a86, rgb(224 222 244 / 0.38))' },
          },

          status: {
            danger:  { value: 'light-dark(#b4637a, #eb6f92)' },
            warning: { value: 'light-dark(#ea9d34, #f6c177)' },
            success: { value: 'light-dark(#56949f, #6bd98f)' },
            info:    { value: 'light-dark(#286983, #9ccfd8)' },
          },
        },
      },
    },
  },

  globalCss: {
    ':root': {
      colorScheme: 'dark',
      '--shadows-sm': '0 1px 2px oklch(0% 0 0 / 0.24), 0 0 0 1px oklch(100% 0 0 / 0.02)',
      '--shadows-md': '0 12px 34px oklch(0% 0 0 / 0.32), 0 1px 0 oklch(100% 0 0 / 0.04) inset',
      '--shadows-lg': '0 24px 70px oklch(0% 0 0 / 0.42), 0 1px 0 oklch(100% 0 0 / 0.06) inset',
      '--page-glow':
        'radial-gradient(circle at 78% 10%, oklch(68% 0.12 292 / 0.16), transparent 34rem), radial-gradient(circle at 12% 18%, oklch(74% 0.10 205 / 0.10), transparent 30rem)',
    },

    '[data-theme=light]': {
      colorScheme: 'light',
      '--shadows-sm': '0 1px 3px oklch(0% 0 0 / 0.08), 0 1px 2px oklch(0% 0 0 / 0.04)',
      '--shadows-md': '0 12px 34px oklch(0% 0 0 / 0.10), 0 1px 0 oklch(100% 0 0 / 0.70) inset',
      '--shadows-lg': '0 24px 70px oklch(0% 0 0 / 0.14), 0 1px 0 oklch(100% 0 0 / 0.80) inset',
      '--page-glow':
        'radial-gradient(circle at 78% 10%, oklch(72% 0.12 292 / 0.14), transparent 34rem), radial-gradient(circle at 12% 18%, oklch(70% 0.10 205 / 0.12), transparent 30rem)',
    },

    '[data-theme=dark]': {
      colorScheme: 'dark',
      '--shadows-sm': '0 1px 2px oklch(0% 0 0 / 0.24), 0 0 0 1px oklch(100% 0 0 / 0.02)',
      '--shadows-md': '0 12px 34px oklch(0% 0 0 / 0.32), 0 1px 0 oklch(100% 0 0 / 0.04) inset',
      '--shadows-lg': '0 24px 70px oklch(0% 0 0 / 0.42), 0 1px 0 oklch(100% 0 0 / 0.06) inset',
      '--page-glow':
        'radial-gradient(circle at 78% 10%, oklch(68% 0.12 292 / 0.16), transparent 34rem), radial-gradient(circle at 12% 18%, oklch(74% 0.10 205 / 0.10), transparent 30rem)',
    },

    'html': {
      '--space-1': 'var(--spacing-1)',
      '--space-2': 'var(--spacing-2)',
      '--space-3': 'var(--spacing-3)',
      '--space-4': 'var(--spacing-4)',
      '--space-5': 'var(--spacing-5)',
      '--space-6': 'var(--spacing-6)',
      '--space-8': 'var(--spacing-8)',
      '--space-10': 'var(--spacing-10)',
      '--space-12': 'var(--spacing-12)',
      '--space-16': 'var(--spacing-16)',
      '--space-20': 'var(--spacing-20)',
      '--space-24': 'var(--spacing-24)',
      '--space-32': 'var(--spacing-32)',

      '--radius-xs': 'var(--radii-xs)',
      '--radius-sm': 'var(--radii-sm)',
      '--radius-md': 'var(--radii-md)',
      '--radius-lg': 'var(--radii-lg)',
      '--radius-xl': 'var(--radii-xl)',
      '--radius-full': 'var(--radii-full)',

      '--dur-fast': 'var(--durations-fast)',
      '--dur-normal': 'var(--durations-normal)',
      '--dur-slow': 'var(--durations-slow)',

      '--ease-out-expo': 'var(--easings-out-expo)',
      '--ease-in-out': 'var(--easings-in-out)',

      '--z-base': 'var(--z-index-base)',
      '--z-raised': 'var(--z-index-raised)',
      '--z-sticky': 'var(--z-index-sticky)',
      '--z-modal': 'var(--z-index-modal)',
      '--z-toast': 'var(--z-index-toast)',
      '--z-tooltip': 'var(--z-index-tooltip)',

      '--surface-1': 'var(--colors-surface-1)',
      '--surface-2': 'var(--colors-surface-2)',
      '--surface-3': 'var(--colors-surface-3)',
      '--surface-glass': 'var(--colors-surface-glass)',
      '--surface-raised': 'var(--colors-surface-raised)',
      '--surface-invert': 'var(--colors-surface-invert)',

      '--text-primary': 'var(--colors-text-primary)',
      '--text-secondary': 'var(--colors-text-secondary)',
      '--text-tertiary': 'var(--colors-text-tertiary)',
      '--text-invert': 'var(--colors-text-invert)',

      '--color-accent': 'var(--colors-accent)',
      '--color-accent-hover': 'var(--colors-accent-hover)',
      '--color-accent-muted': 'var(--colors-accent-muted)',
      '--color-accent-soft': 'var(--colors-accent-soft)',
      '--color-accent-cyan': 'var(--colors-accent-cyan)',
      '--color-accent-gold': 'var(--colors-accent-gold)',
      '--color-accent-rose': 'var(--colors-accent-rose)',
      '--color-accent-success': 'var(--colors-accent-success)',

      '--border-subtle': 'var(--colors-border-subtle)',
      '--border-default': 'var(--colors-border)',
      '--border-strong': 'var(--colors-border-strong)',

      '--shadow-sm': 'var(--shadows-sm)',
      '--shadow-md': 'var(--shadows-md)',
      '--shadow-lg': 'var(--shadows-lg)',

      '--accent-100': 'var(--colors-accent-muted)',
      '--accent-700': 'var(--colors-accent-hover)',
    },
  },
});

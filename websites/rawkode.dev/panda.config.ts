import { defineConfig } from '@pandacss/dev';

/**
 * Design system for rawkode.dev.
 *
 * The site is dark-first and mobile-first. The palette is a screen-printed
 * gig poster: near-black ink, true off-white paper, and one fluorescent
 * pink borrowed from Rawkode Academy.
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
          sans: { value: "'Archivo Variable', 'Archivo', system-ui, sans-serif" },
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
          xs: { value: '1px' },
          sm: { value: '2px' },
          md: { value: '3px' },
          lg: { value: '4px' },
          xl: { value: '6px' },
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
          /* Stage: near-black ink and fluorescent pink, like a screen-printed gig poster. */
          ink: {
            950: { value: 'oklch(0.16 0.008 355)' },
            900: { value: 'oklch(0.195 0.01 355)' },
            850: { value: 'oklch(0.235 0.012 355)' },
            100: { value: 'oklch(0.965 0.006 355)' },
          },
          /* Rawkode Academy's accent (#ff7ab6), tuned per theme for contrast. */
          signal: {
            dark: { value: 'oklch(0.76 0.165 355)' },
            light: { value: 'oklch(0.55 0.2 357)' },
          },
        },
      },

      semanticTokens: {
        colors: {
          surface: {
            '1':       { value: 'light-dark(oklch(0.975 0.002 355), oklch(0.16 0.008 355))' },
            '2':       { value: 'light-dark(oklch(1 0 0), oklch(0.195 0.01 355))' },
            '3':       { value: 'light-dark(oklch(0.935 0.004 355), oklch(0.235 0.012 355))' },
            glass:     { value: 'light-dark(oklch(1 0 0 / 0.8), oklch(0.195 0.01 355 / 0.8))' },
            raised:    { value: 'light-dark(oklch(1 0 0), oklch(0.235 0.012 355))' },
            invert:    { value: 'light-dark(oklch(0.18 0.012 355), oklch(0.965 0.006 355))' },
          },

          text: {
            primary:   { value: 'light-dark(oklch(0.18 0.012 355), oklch(0.965 0.006 355))' },
            secondary: { value: 'light-dark(oklch(0.38 0.014 355), oklch(0.8 0.01 355))' },
            tertiary:  { value: 'light-dark(oklch(0.48 0.014 355), oklch(0.68 0.012 355))' },
            invert:    { value: 'light-dark(oklch(0.975 0.002 355), oklch(0.16 0.008 355))' },
          },

          accent: {
            DEFAULT: { value: 'light-dark(oklch(0.55 0.2 357), oklch(0.76 0.165 355))' },
            hover:   { value: 'light-dark(oklch(0.47 0.18 357), oklch(0.83 0.13 355))' },
            ink:     { value: 'light-dark(oklch(0.99 0 0), oklch(0.15 0.03 355))' },
            muted:   { value: 'light-dark(oklch(0.55 0.2 357 / 0.1), oklch(0.76 0.165 355 / 0.14))' },
            soft:    { value: 'light-dark(oklch(0.55 0.2 357 / 0.14), oklch(0.76 0.165 355 / 0.18))' },
            cyan:    { value: 'light-dark(oklch(0.55 0.2 357), oklch(0.76 0.165 355))' },
            gold:    { value: 'light-dark(oklch(0.55 0.2 357), oklch(0.76 0.165 355))' },
            rose:    { value: 'light-dark(oklch(0.55 0.2 357), oklch(0.76 0.165 355))' },
            success: { value: 'light-dark(oklch(0.5 0.13 150), oklch(0.78 0.16 150))' },
          },

          border: {
            subtle:  { value: 'light-dark(oklch(0.18 0.012 355 / 0.12), oklch(0.965 0.006 355 / 0.12))' },
            DEFAULT: { value: 'light-dark(oklch(0.18 0.012 355 / 0.24), oklch(0.965 0.006 355 / 0.24))' },
            strong:  { value: 'light-dark(oklch(0.18 0.012 355 / 0.7), oklch(0.965 0.006 355 / 0.7))' },
          },

          status: {
            danger:  { value: 'light-dark(oklch(0.55 0.2 357), oklch(0.76 0.165 355))' },
            warning: { value: 'light-dark(oklch(0.6 0.14 70), oklch(0.82 0.14 80))' },
            success: { value: 'light-dark(oklch(0.5 0.13 150), oklch(0.78 0.16 150))' },
            info:    { value: 'light-dark(oklch(0.18 0.012 355), oklch(0.965 0.006 355))' },
          },
        },
      },
    },
  },

  globalCss: {
    ':root': {
      colorScheme: 'dark light',
      '--shadows-sm': 'none',
      '--shadows-md': 'none',
      '--shadows-lg': '0 30px 80px oklch(0% 0 0 / 0.35)',
      '--page-glow':
        'none',
    },

    '[data-theme=light]': {
      colorScheme: 'light',
      '--shadows-sm': 'none',
      '--shadows-md': 'none',
      '--shadows-lg': '0 30px 80px oklch(0% 0 0 / 0.35)',
      '--page-glow':
        'none',
    },

    '[data-theme=dark]': {
      colorScheme: 'dark',
      '--shadows-sm': 'none',
      '--shadows-md': 'none',
      '--shadows-lg': '0 30px 80px oklch(0% 0 0 / 0.35)',
      '--page-glow':
        'none',
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
      '--color-accent-ink': 'var(--colors-accent-ink)',

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

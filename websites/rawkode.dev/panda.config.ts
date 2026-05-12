import { defineConfig } from '@pandacss/dev';

/**
 * Design system for rawkode.dev.
 *
 * Two palettes drive every surface, text and accent token:
 *   • Light: Rosé Pine Dawn  (https://rosepinetheme.com/palette/ingredients/)
 *   • Dark : Catppuccin Frappé (https://catppuccin.com/palette/)
 *
 * Theme reactivity is handled by the platform — `color-scheme` + `light-dark()`
 * — so OS preference changes apply with zero JavaScript. The Nav toggle only
 * writes an explicit `[data-theme]` override when the user opts out of system.
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
          serif: { value: "'Newsreader Variable', 'Newsreader', Georgia, serif" },
          mono: { value: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, monospace" },
        },

        spacing: {
          '1': { value: '0.25rem' },
          '2': { value: '0.5rem' },
          '3': { value: '0.75rem' },
          '4': { value: '1rem' },
          '6': { value: '1.5rem' },
          '8': { value: '2rem' },
          '12': { value: '3rem' },
          '16': { value: '4rem' },
          '24': { value: '6rem' },
          '32': { value: '8rem' },
        },

        radii: {
          sm: { value: '4px' },
          md: { value: '8px' },
          lg: { value: '16px' },
          xl: { value: '24px' },
          full: { value: '9999px' },
        },

        durations: {
          fast: { value: '120ms' },
          normal: { value: '240ms' },
          slow: { value: '400ms' },
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
          /* Rosé Pine Dawn — light palette */
          rosePineDawn: {
            base: { value: '#faf4ed' },
            surface: { value: '#fffaf3' },
            overlay: { value: '#f2e9e1' },
            muted: { value: '#9893a5' },
            subtle: { value: '#797593' },
            text: { value: '#575279' },
            love: { value: '#b4637a' },
            gold: { value: '#ea9d34' },
            rose: { value: '#d7827e' },
            pine: { value: '#286983' },
            foam: { value: '#56949f' },
            iris: { value: '#907aa9' },
            highlightLow: { value: '#f4ede8' },
            highlightMed: { value: '#dfdad9' },
            highlightHigh: { value: '#cecacd' },
          },

          /* Catppuccin Frappé — dark palette */
          catppuccinFrappe: {
            rosewater: { value: '#f2d5cf' },
            flamingo: { value: '#eebebe' },
            pink: { value: '#f4b8e4' },
            mauve: { value: '#ca9ee6' },
            red: { value: '#e78284' },
            maroon: { value: '#ea999c' },
            peach: { value: '#ef9f76' },
            yellow: { value: '#e5c890' },
            green: { value: '#a6d189' },
            teal: { value: '#81c8be' },
            sky: { value: '#99d1db' },
            sapphire: { value: '#85c1dc' },
            blue: { value: '#8caaee' },
            lavender: { value: '#babbf1' },
            text: { value: '#c6d0f5' },
            subtext1: { value: '#b5bfe2' },
            subtext0: { value: '#a5adce' },
            overlay2: { value: '#949cbb' },
            overlay1: { value: '#838ba7' },
            overlay0: { value: '#737994' },
            surface2: { value: '#626880' },
            surface1: { value: '#51576d' },
            surface0: { value: '#414559' },
            base: { value: '#303446' },
            mantle: { value: '#292c3c' },
            crust: { value: '#232634' },
          },
        },
      },

      /**
       * Semantic colours use CSS `light-dark()`. The browser picks the right
       * value based on the active `color-scheme`, so a user toggling their OS
       * preference flips the theme without any JS reacting to media changes.
       */
      semanticTokens: {
        colors: {
          surface: {
            '1':     { value: 'light-dark({colors.rosePineDawn.base},          {colors.catppuccinFrappe.base})' },
            '2':     { value: 'light-dark({colors.rosePineDawn.surface},       {colors.catppuccinFrappe.surface0})' },
            '3':     { value: 'light-dark({colors.rosePineDawn.overlay},       {colors.catppuccinFrappe.surface1})' },
            invert:  { value: 'light-dark({colors.catppuccinFrappe.base},      {colors.rosePineDawn.base})' },
          },

          text: {
            primary:   { value: 'light-dark({colors.rosePineDawn.text},   {colors.catppuccinFrappe.text})' },
            secondary: { value: 'light-dark({colors.rosePineDawn.subtle}, {colors.catppuccinFrappe.subtext0})' },
            tertiary:  { value: 'light-dark({colors.rosePineDawn.muted},  {colors.catppuccinFrappe.overlay1})' },
            invert:    { value: 'light-dark({colors.rosePineDawn.base},   {colors.catppuccinFrappe.base})' },
          },

          accent: {
            DEFAULT: { value: 'light-dark({colors.rosePineDawn.pine},          {colors.catppuccinFrappe.blue})' },
            hover:   { value: 'light-dark({colors.rosePineDawn.foam},          {colors.catppuccinFrappe.lavender})' },
            muted:   { value: 'light-dark({colors.rosePineDawn.highlightMed},  {colors.catppuccinFrappe.surface1})' },
          },

          border: {
            subtle:  { value: 'light-dark({colors.rosePineDawn.highlightMed},  {colors.catppuccinFrappe.surface0})' },
            DEFAULT: { value: 'light-dark({colors.rosePineDawn.highlightHigh}, {colors.catppuccinFrappe.surface1})' },
          },

          status: {
            danger:  { value: 'light-dark({colors.rosePineDawn.love}, {colors.catppuccinFrappe.red})' },
            warning: { value: 'light-dark({colors.rosePineDawn.gold}, {colors.catppuccinFrappe.yellow})' },
            success: { value: 'light-dark({colors.rosePineDawn.foam}, {colors.catppuccinFrappe.green})' },
            info:    { value: 'light-dark({colors.rosePineDawn.iris}, {colors.catppuccinFrappe.mauve})' },
          },
        },
      },
    },
  },

  globalCss: {
    /* Wire the platform up: declare which schemes :root supports, and let
       explicit overrides constrain it. light-dark() resolves accordingly. */
    ':root': {
      colorScheme: 'light dark',

      /* Shadows can't use light-dark() (it's colour-only), so they remain
         CSS-only with a media-query default + data-theme overrides. */
      '--shadows-sm': '0 1px 3px oklch(0% 0 0 / 0.06), 0 1px 2px oklch(0% 0 0 / 0.04)',
      '--shadows-md': '0 4px 12px oklch(0% 0 0 / 0.08), 0 2px 4px oklch(0% 0 0 / 0.04)',
      '--shadows-lg': '0 8px 32px oklch(0% 0 0 / 0.12), 0 4px 8px oklch(0% 0 0 / 0.06)',
    },

    '@media (prefers-color-scheme: dark)': {
      ':root:not([data-theme=light])': {
        '--shadows-sm': '0 1px 3px oklch(0% 0 0 / 0.4), 0 1px 2px oklch(0% 0 0 / 0.24)',
        '--shadows-md': '0 4px 12px oklch(0% 0 0 / 0.5), 0 2px 4px oklch(0% 0 0 / 0.3)',
        '--shadows-lg': '0 8px 32px oklch(0% 0 0 / 0.6), 0 4px 8px oklch(0% 0 0 / 0.4)',
      },
    },

    '[data-theme=light]': {
      colorScheme: 'light',
      '--shadows-sm': '0 1px 3px oklch(0% 0 0 / 0.06), 0 1px 2px oklch(0% 0 0 / 0.04)',
      '--shadows-md': '0 4px 12px oklch(0% 0 0 / 0.08), 0 2px 4px oklch(0% 0 0 / 0.04)',
      '--shadows-lg': '0 8px 32px oklch(0% 0 0 / 0.12), 0 4px 8px oklch(0% 0 0 / 0.06)',
    },

    '[data-theme=dark]': {
      colorScheme: 'dark',
      '--shadows-sm': '0 1px 3px oklch(0% 0 0 / 0.4), 0 1px 2px oklch(0% 0 0 / 0.24)',
      '--shadows-md': '0 4px 12px oklch(0% 0 0 / 0.5), 0 2px 4px oklch(0% 0 0 / 0.3)',
      '--shadows-lg': '0 8px 32px oklch(0% 0 0 / 0.6), 0 4px 8px oklch(0% 0 0 / 0.4)',
    },

    /* Legacy aliases — keeps existing components working unchanged while
       components migrate to css() / token() over time. */
    'html': {
      '--space-1': 'var(--spacing-1)',
      '--space-2': 'var(--spacing-2)',
      '--space-3': 'var(--spacing-3)',
      '--space-4': 'var(--spacing-4)',
      '--space-6': 'var(--spacing-6)',
      '--space-8': 'var(--spacing-8)',
      '--space-12': 'var(--spacing-12)',
      '--space-16': 'var(--spacing-16)',
      '--space-24': 'var(--spacing-24)',
      '--space-32': 'var(--spacing-32)',

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
      '--surface-invert': 'var(--colors-surface-invert)',

      '--text-primary': 'var(--colors-text-primary)',
      '--text-secondary': 'var(--colors-text-secondary)',
      '--text-tertiary': 'var(--colors-text-tertiary)',
      '--text-invert': 'var(--colors-text-invert)',

      '--color-accent': 'var(--colors-accent)',
      '--color-accent-hover': 'var(--colors-accent-hover)',
      '--color-accent-muted': 'var(--colors-accent-muted)',

      '--border-subtle': 'var(--colors-border-subtle)',
      '--border-default': 'var(--colors-border)',

      '--shadow-sm': 'var(--shadows-sm)',
      '--shadow-md': 'var(--shadows-md)',
      '--shadow-lg': 'var(--shadows-lg)',

      '--accent-100': 'var(--colors-accent-muted)',
      '--accent-700': 'var(--colors-accent-hover)',
    },
  },
});

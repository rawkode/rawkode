# Design

## Visual System

Enchiridion uses a restrained product interface: quiet white content surfaces, a slightly tinted structural chrome, compact typography, and one warm amber accent for selection and primary actions. The app is designed for long writing and review sessions in normal desk lighting, so the surface stays light and readable rather than dark or theatrical.

## Color Tokens

```css
:root {
	--color-bg: oklch(1 0 0);
	--color-chrome: oklch(0.965 0.006 50);
	--color-surface: oklch(0.985 0.002 50);
	--color-surface-raised: oklch(1 0 0);
	--color-ink: oklch(0.18 0.018 55);
	--color-muted: oklch(0.46 0.018 55);
	--color-subtle: oklch(0.69 0.014 55);
	--color-border: oklch(0.88 0.012 55);
	--color-primary: oklch(0.40 0.103 50);
	--color-primary-hover: oklch(0.34 0.112 50);
	--color-primary-soft: oklch(0.93 0.038 50);
	--color-accent: oklch(0.36 0.094 215);
	--color-success: oklch(0.48 0.11 150);
	--color-warning: oklch(0.62 0.14 75);
	--color-danger: oklch(0.52 0.17 28);
}
```

## Typography

Use the system UI stack for all product surfaces. Use a compact scale with `12px`, `13px`, `14px`, `16px`, `18px`, `24px`, and `30px` sizes. Reserve larger text for page titles only. Use `ui-monospace` for IDs, dates, model names, and command payload previews.

## Layout

Use a three-column product shell on desktop: navigation, writing surface, and context rail. Collapse to a single-column stacked layout on mobile with persistent top navigation. Cards are only used for repeated resources, app records, and small status panels. Page sections remain unframed.

## Components

Primary controls use the amber accent with white text. Secondary controls use borders. Editor blocks use compact headers, clear labels, and stable dimensions so embedded app views do not resize unpredictably. Command palette, slash menu, and scheduled workflow log use the same command-row vocabulary.

## Implementation

StyleX owns reusable design-system tokens and React component recipes. Tokens live in `src/styles/tokens.stylex.ts`, and shell-level recipes live in `src/styles/shell.stylex.ts`. Global CSS is limited to reset, document defaults, and Tiptap/ProseMirror internals that are not normal React component markup.

## Motion

Keep motion functional and short: state changes, palette open/close, autosave feedback, and row insertion. Respect `prefers-reduced-motion` by disabling transforms and retaining instant state changes.

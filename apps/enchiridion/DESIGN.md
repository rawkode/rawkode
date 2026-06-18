# Design

## Visual System

Enchiridion uses a restrained product interface adapted from Vercel's Geist token vocabulary: neutral surfaces, compact typography, tight radii, subtle borders, and explicit focus/state colors. Color comes from Rose Pine Dawn in light mode and Catppuccin Mocha in dark mode. Accent color is reserved for primary actions, current selection, links, focus, and state indicators.

The app is designed for long writing and review sessions. Light mode reads as a warm desk surface; dark mode reads as a quiet operator console without turning every inactive control into saturated color.

## Color Tokens

Global CSS owns the active theme values. StyleX component tokens point to these custom properties so React surfaces, editor internals, fallback pages, and generated mini-app pages share the same palette.

```css
:root {
	color-scheme: light;
	--color-bg: #faf4ed;
	--color-chrome: #f2e9e1;
	--color-surface: #fffaf3;
	--color-surface-raised: #fffaf3;
	--color-ink: #464261;
	--color-muted: #6e6a86;
	--color-subtle: #797593;
	--color-border: #dfdad9;
	--color-border-strong: #cecacd;
	--color-primary: #286983;
	--color-primary-hover: #1f566c;
	--color-primary-soft: rgb(40 105 131 / 0.12);
	--color-accent: #907aa9;
}

@media (prefers-color-scheme: dark) {
	:root {
		color-scheme: dark;
		--color-bg: #1e1e2e;
		--color-chrome: #181825;
		--color-surface: #313244;
		--color-surface-raised: #1e1e2e;
		--color-ink: #cdd6f4;
		--color-muted: #bac2de;
		--color-subtle: #9399b2;
		--color-border: #45475a;
		--color-border-strong: #585b70;
		--color-primary: #89b4fa;
		--color-primary-hover: #b4befe;
		--color-primary-soft: rgb(137 180 250 / 0.16);
		--color-accent: #cba6f7;
	}
}
```

Semantic tokens extend the same palettes for `info`, `success`, `warning`, and `danger`. Text-oriented semantic values are tuned for WCAG AA contrast instead of blindly using the lightest palette chip.

## Typography

Prefer Geist Sans and Geist Mono when available, then fall back to the system UI stack. Use the compact product scale already in `src/styles/tokens.stylex.ts`: `11px`, `12px`, `13px`, `14px`, `16px`, and `24px`. Reserve larger text for page titles only. Use the mono stack for IDs, dates, model names, and command payload previews.

## Layout

Use a three-column product shell on desktop: navigation, writing surface, and context rail. Collapse to a single-column stacked layout on mobile with persistent top navigation. Spacing follows a 4px-centered rhythm: tight gaps inside control groups, 16px between related groups, and 32px or more between larger sections. Cards are only used for repeated resources, app records, and small status panels.

## Components

Controls follow Geist's component grammar: 6px everyday radii, 8px compact panels, 12px menus/dialogs, subtle borders first, shadows only for popovers and floating panels. Primary controls use the theme primary color. Secondary controls use raised surfaces and borders. Every interactive control needs hover, focus-visible, disabled, and active/selected states.

Editor blocks, command palette rows, slash menu items, scheduled workflow rows, and mini-app records share the same command-row vocabulary: icon, primary label, muted metadata, and an explicit state chip when needed.

## Implementation

StyleX owns reusable component recipes. Tokens live in `src/styles/tokens.stylex.ts`; shell-level recipes live in `src/styles/shell.stylex.ts`. Global CSS is limited to reset, theme variables, document defaults, and Tiptap/ProseMirror internals that are not normal React component markup.

Fallback mini-app error pages and static generated mini-app pages define the same light/dark token subset inline so surfaces outside the host shell do not fall back to the old light-only theme.

## Motion

Keep motion functional and short: state changes, palette open/close, autosave feedback, and row insertion. Prefer 150ms state transitions, 200ms popovers, and 300ms overlays. Respect `prefers-reduced-motion` by disabling transforms and retaining instant state changes.

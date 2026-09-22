# Design

rawkode.dev is set like a screen-printed gig poster: rawkode = rock + code.
The apps are billed like a festival lineup, the Academy gets the one drenched
surface, and the portrait is a two-colour print.

The accent is Rawkode Academy's pink (`#ff7ab6`), which ties the two sites
together and is also a classic fluorescent screen-print ink. It replaced an
earlier signal red that read as hostile.

## Colour

Committed strategy: near-black ink, true off-white paper, one fluorescent
pink. Neutrals carry a trace of the pink's hue (355) so they belong to it.
Tokens live in `panda.config.ts` as `light-dark()` pairs; the `[data-theme]`
contract and the system-theme fallback are unchanged.

| Role | Dark | Light |
| :-- | :-- | :-- |
| Surface (`--surface-1`) | `oklch(0.16 0.008 355)` | `oklch(0.975 0.002 355)` |
| Ink (`--text-primary`) | `oklch(0.965 0.006 355)` | `oklch(0.18 0.012 355)` |
| Accent (`--color-accent`) | `oklch(0.76 0.165 355)` | `oklch(0.55 0.2 357)` |
| Text on accent (`--color-accent-ink`) | `oklch(0.15 0.03 355)` | white |

Measured contrast: body ≥ 9:1, tertiary ≥ 6:1, accent on surface ≥ 5:1,
text on accent ≥ 5.2:1, in both themes.

Pink is for the surname, hover ink, the primary button, the portrait duotone,
the footer wordmark, and the Academy drench. Keep it off body copy.

## Type

One family: Archivo variable, using its width axis (62–125%).

- `.poster`: 62% width, weight 860, uppercase, line-height 0.86. Use it for
  names, section titles, and lineup acts.
- Headings: 72–78% width, weight 780–820, sentence case.
- Body: 100% width, weight 400, 17px, 68ch measure.
- Billing lines ("Rawkode presents"): 125% width italic. They exist to show
  the other end of the axis.

Poster headings that must fill a column use container units
(`font-size: min(Xrem, 100cqi / ratio)`), so they never overflow.

## Motion

- Hero name: rises and compresses from 125% to 62% width on load.
- Lineup acts: pink wipes across the name on hover/focus (clip-path).
- Portrait: prints in from the bottom (clip-path).
- Scroll-driven extras (lineup tiers, article progress bar) sit behind
  `@supports (animation-timeline: …)`.
- Reduced motion zeroes durations *and* delays, so nothing waits hidden.

## Rules

- No cards. Content sits on rules (1px `--border-default`, 2px ink for strong
  breaks).
- Square corners (1–4px) except topic pills.
- No shadows or glass. Poster print is flat.
- The OG image (`scripts/generate-og.mjs`) mirrors the hero. It renders with
  a system sans because librsvg can't load the Archivo woff2.

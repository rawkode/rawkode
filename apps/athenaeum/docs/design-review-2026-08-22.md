# Athenaeum adversarial design review — synthesis (2026-08-22)

David's instruction, verbatim: **"Adversarial review everything UI and UX. maybe this isn't the
color scheme, or the layout, etc. assume nothing."**

This report merges four independent lenses — writing-tool first principles (`lens-writing.md`),
IA & layout (`lens-layout.md`), comparative teardown (`lens-comparative.md`), and live task-flow
walkthroughs (`lens-flows.md`) — over the shared evidence base in
`docs/design-review-shots/` (`inventory.md` + 40 screenshots, all measured against the running app
at 1440×900 and emulated 390×844). Where a lens claim conflicted with another lens or with the
source CSS/TSX, the conflict is adjudicated explicitly in §2, not averaged.

Fixed product truths (not up for review): personal all-day tool for David; centered on daily
notes + Supertags; the existing feature set stays reachable. Everything else — palette, theme,
layout, rail, typography, chrome — was treated as a hypothesis under attack.

---

## 1. Ranked findings (deduped across all four lenses)

Classes: **OBJ** = objective, measurable defect · **DIR** = direction-level, defensible either
way, needs David's decision · **TASTE** = labeled taste. Lens refs use the original IDs
(W=writing, O/D/T=layout, C§=comparative section, F=flows).

| # | Class | Sev | Finding | Evidence | Fix direction | Lenses |
|---|---|---|---|---|---|---|
| 1 | OBJ | **Critical** | **Retrieval does not exist.** No search, no ⌘K, calendar is today-only, graph rows aren't clickable, `entity-ref` mentions and backlink entries are inert text — there is no UI path to open any note except today's | Live-verified: `flow-3-graph-no-links.png`; DOM checks (no search input, `span.entity-ref` `cursor:text` no handler, backlinks as `<strong>`) | Prev/next chevrons + date popover on the note header (`/notes/:date`); a command palette (⌘K) for search; graph titles become links | F3.\*, C§1, D3 |
| 2 | OBJ | High | **Silent data loss in supertag fields**: Enter doesn't commit, closing the popover discards typed values with no warning, Save gives zero feedback | Live-verified: typed email lost on close, confirmed by reopen (`flow-1-field-saved.png`) | Commit on blur/Enter (Tana/Notion convention); delete per-field Save buttons; dirty-guard on close | F1.4, C§2 |
| 3 | OBJ | High | **Prose gets 294px (~28ch) beside a 320px backlinks column**, and the whole layout flips on an 8px container-query margin (744px container vs 46rem=736px threshold) — the same 1440px window rendered both states; typing enough to spawn a scrollbar halves your own line length | `notes-backlinks-1440.png` vs `notes-1440.png`; `inventory.md` measured grid `294px + 32 + 320`; live flip re-confirmed mid-session (F1.7); source: `app.css:473-477` | Backlinks below the note, always; delete the `@container notes (min-width: 46rem)` branch. One change deletes three findings (W1+W2+D5) | W1, W2, O1, O2, D5, C§1, F1.7 |
| 4 | OBJ | High | **`#` picker renders fully off-screen when the caret is in the bottom ~250px** (menu at y=899 in a 900px viewport, no flip logic) — precisely where the caret lives as a daily note grows | Live-measured: `.rich-supertag-menu` top=899, 256px tall; `flow-1-hash-picker.png` shows "# typed, nothing happens" | Flip the menu above the caret when there's no room below | F1.2 |
| 5 | OBJ | High | **Field popover is pinned to the viewport's bottom-right corner** (fixed 32px margins, measured across three opens), ~700–900px from the pill it edits, overlapping the chat rail | `notes-field-popover-1440.png`, `flow-1-after-apply.png`; measured x=1088–1408, bottom=868 | Anchor to the invoking chip/caret with flip logic; also: Escape must close it (F1.5) | F1.3, F1.5, C§2 |
| 6 | OBJ | High | **Sharing ships raw red error strings as its steady state** ("This workspace doesn't exist (or was deleted).", twice) on a workspace that manifestly exists | `sharing-1440.png` — verified by direct inspection | Fix the underlying query; render error states distinctly from empty states (shared EmptyState component) | C§7 |
| 7 | DIR | High | **Supertags are note-level, not node-level**: tagging "Alex #Person" inline reopens the daily note's own Person instance (role="Platform Engineer" from a previous application); a second person cannot be tagged without corrupting the first. In Tana — the explicit reference — tags attach to the node, minting a reusable object | Live-verified (F1.6); the deepest product-model question found | David's call: node/block-level tags (Tana semantics), or make the inline `#` visibly mean "tags this note". The current UI promises Tana and delivers something else | F1.6, C§2 |
| 8 | DIR | High | **Permanently docked 352px chat rail (24.4% of 1440px) on every route**, whose resting content is administrative (title-first creation form, "No chats yet.", an empty PENDING CHANGES section explaining its own mechanics) — including when the agent cannot reply at all | Every 1440 screenshot; `chat-rail-1440.png`; O8 | Rail summonable/collapsible with remembered state + hotkey; auto-expand when changes are pending; PENDING CHANGES renders only when non-empty | W8, D1, O8, C§5, F4.2 |
| 9 | DIR | High | **Dark-only with no light palette in existence** for an all-day prose tool — and the dark that exists sets prose at ~15:1, a halation risk for hours of serif reading | `tokens.css:7-11` ("dark-first AND dark-only"); measured #f0e6da on #0b181d ≈ 15:1 | Build a light theme, follow OS preference, keep dark as night mode; if dark stays, drop prose (not UI) to ~10–12:1 | W5, W6 |
| 10 | DIR | High | **45% of the writing screen is writing; 55% is chrome.** ~285px of header ceremony (three renderings of the date) before the first word; bordered card-in-a-case; permanent green "Synced"; always-visible backlink form; admin block atop the sidebar | `notes-1440.png` measured; W7's itemized iA-Writer deletion list | While the caret is in the note, chrome recedes: one-line header, full-bleed or quiet page, sync silent unless failing, forms behind disclosure | W7, W9, D4, D2, D6 |
| 11 | OBJ | Med-High | **Title-before-message chat creation**: you must invent a chat name before you can ask anything; no reference product (Cursor, ChatGPT, Claude, Notion AI) does this | `chat-rail-1440.png`, `notes-1440.png` empty state | Composer-first: sending the first message creates + auto-titles the chat | C§5 |
| 12 | OBJ | Med-High | **The Supertags manager never shows any tag's schema** — rows are names + an unexplained "BASE" badge; fields (the route's stated purpose) are invisible; the 8-checkbox parent picker permanently occupies the top of the page | `supertags-1440.png` | Fields inline per row (`role · email · company`, inheritance line, usage count); creation behind `+ New Supertag`; explain or drop "BASE" | C§3 |
| 13 | OBJ | Medium | **Four permanently docked creation forms** (new workspace w/ disabled button, new chat, backlink create, supertag create) give rare actions permanent prime space — the app's dominant IA pattern inverts frequency-of-use | `notes-1440.png`, `chat-rail-1440.png`, `supertags-1440.png`; O5 inventory of all four | Creation behind `+` affordances / commands; the inline `@`/`#` pickers already do this correctly | O5, W10, W3, C§1, C cross-cutting |
| 14 | OBJ | Medium | **Schema is write-only**: no tag delete/rename, no field edit/remove, parents locked at creation — every experiment is permanent | Live-verified (`flow-2-book-defined.png`); test `#Book` now lives in the picker forever | Full CRUD on tags/fields/parents | F2.1, C§3 |
| 15 | OBJ | Medium | **No editor autofocus on load** — `document.activeElement` is BODY; the first act of every morning is a mouse click | Live-verified (`flow-1-open.png`) | Focus today's note on arrival | F1.1 |
| 16 | OBJ | Medium | **Empty daily note never invites writing** — no placeholder, no caret affordance; the page's most prominent interactive element is the backlink-creation form | `notes-empty-1440.png` | Placeholder in the prose font ("What's happening today? — # to tag, @ to link") + autofocus | W3, D6, C§1 |
| 17 | OBJ | Medium | **Graph route is mislabeled and leaks debug chrome**: "Knowledge Graph" renders a read-only table with `ID 00000000`, caption `graph_nodes · VIA runView`, one hard-coded "Only nodes tagged 'Person'" checkbox; supertag fields never appear as columns | `graph-1440.png`, `flow-3-graph-no-links.png` | Tag-scoped field columns (the whole payoff of defining fields), sortable; drop IDs/debug caption; rename to Nodes/Database | C§4 |
| 18 | OBJ | Medium | **No-model error reply is ephemeral** — navigate away and back, and sent messages sit unanswered with no explanation | Live-verified; rail visible in `flow-5-app-launched.png` | Persist the notice (or an "agent offline" banner on the rail) | F4.1 |
| 19 | OBJ | Medium | **Both mobile drawers can stack** — `chatOpen` and `sidebarOpen` are independent `useState`s; neither toggle closes the other; the capture shows the stacked state with two ✕ buttons | `nav-drawer-390.png`; **confirmed in source**: `AppShell.tsx:69-70,144,158` | Opening one drawer closes the other | O7 (upgraded from "needs repro" — see §2.3) |
| 20 | OBJ | Medium | **Raw workspace UUID as permanent chrome, twice** — sidebar footer (truncated mid-string) and inside the workspace `<select>` option text (causing visible clipping) | `notes-1440.png` bottom-left; O4 | UUID behind an "About/Copy workspace ID" action; option text = name only | O4 |
| 21 | OBJ | Medium | **Empty states describe the architecture, not the next action** — Meetings/Workouts lead with transcription-stack paragraphs; Apps leads with "Worker Loader isolate"; the SANDBOXED eyebrow headlines plumbing | `meetings-1440.png`, `workouts-1440.png`, `apps-1440.png` | Shared EmptyState recipe (one benefit line + one CTA); demote isolation copy to a single reassurance line | C§6, C§7, F5.2 |
| 22 | DIR | Medium | **Model setup is a `wrangler` CLI command inside end-user chat**; no settings surface exists anywhere | `chat-rail-1440.png`, `flow-4-no-model.png` | A "connect a model" setup state/settings surface (the copy itself is honest and good dev copy) | F4.2 |
| 23 | DIR | Medium | **Admin block owns the top of the sidebar** — brand → workspace select → new-workspace form → account/DEV/sign-out before "Today", which starts ~330px down a 900px viewport | `notes-1440.png` | One compact workspace row whose menu holds switch/create/settings/sign-out; Today becomes the first thing the eye lands on | D2 |
| 24 | DIR | Medium | **The MORE list: zero of seven items earn permanent rows as-is** — Calendar's own subtitle says it belongs in Today; Meetings/Workouts should be supertag-generated views (the product's own primitive, Tana-style); Bookmarks/Graph/Sharing/Apps are palette/menu-tier. And no command palette exists to absorb them | Sidebar in every screenshot; `calendar-1440.png` subtitle | Calendar merges into Today; pinnable supertag views; ⌘K absorbs the rest (also serves #1) | D3 |
| 25 | DIR | Medium | **Two disconnected schema-editing surfaces** — the in-note popover can create tags and fields (the whole Flow-2 round trip was unnecessary) but nothing teaches it; /supertags never mentions the inline path | Live-verified (F2.2) | Make the inline path the taught path; reposition /supertags as the schema browser | F2.2 |
| 26 | DIR | Low-Med | **Inline metadata outshines the author's words** — filled teal Person pill and bright entity-ref links are the highest-salience objects in the paragraph. OBJ sub-point: "Person" (inline pill) vs "#Person" (tag row) — same object, two spellings on one screen | `notes-1440.png`; note: `rich-text.css:128-134` documents the loud chip as deliberate — see §2.5 | Tags/links half a step quieter than prose; one spelling everywhere | W12 |
| 27 | OBJ | Low | Chat error box overlaps the message bubble above it | `flow-4-no-model.png` | Margin fix | F4.4 |
| 28 | OBJ | Low | No sizing/theme contract for launched app iframes (tiny unstyled `+1` in an empty ~1000×700 panel) | `flow-5-app-launched.png` | Define an app layout/theme contract before agent-authored apps arrive | F5.1 |
| 29 | OBJ | Low | Mobile Agent pill is the brightest object on the writing screen (solid accent cyan); pills occlude content mid-scroll | `notes-390.png`; occlusion partially mitigated in source — see §2.2 | Quiet resting style for the pills; keep the reserved scroll-past band | W4, O6 |
| — | TASTE | — | Three typefaces on one card; Space Grotesk's techno register carries the "command-center" voice against the literary serif | `notes-1440.png` | A two-font system would calm the page (variant A tests this) | W11 |
| — | TASTE | — | Nav typography is control-room loud (Space Grotesk 600 · 19.2px · 56px rows — larger and heavier than the note's own prose) | inventory §Typography | Nav a size down, weight down | T1 |
| — | TASTE | — | Twin visible scrollbar tracks flank the main column; symmetric rail/ground/rail composition reads as a tunnel | `notes-1440.png` | Overlay scrollbars / asymmetric composition | T2, T3 |
| — | TASTE | — | Parent checkboxes read as a list filter; "see the report accompanying this build" is unlinked dead-end copy | `flow-2-book-defined.png`, `flow-4-no-model.png` | Progressive disclosure; link or cut | F2.3, F4.3 |

### What is right (protect these)

- The **single-column measure**: ~65ch Source Serif at 19.2px/33.6px with 1.75 leading is
  genuinely good — better than most notes apps ship. Findings #3/#10 exist to *protect* it.
- **Source Serif for prose**, and the restraint of the motion system (one easing, ≤280ms,
  transform/opacity only, global reduced-motion kill switch).
- The **at-caret `#`/`@` pickers** — the inline-command model is exactly right (which is why the
  permanent forms are unnecessary).
- The **pending-changes diff-review concept** in chat is ahead of most chat panels; only its
  packaging lags.
- The failure copy ("No AI model configured…") is honest and names the exact fix.
- Flow 5 (Apps round trip) and Flow 2's data plumbing (new tag instantly usable, no refresh)
  work coherently.

---

## 2. Adjudications — where lenses conflicted, with reasoning

**2.1 — O3 "chat rail unreachable at 500–852px" is a FALSE POSITIVE.** The layout lens flagged
the rail rendering off-viewport at a 500px window with no scrollable ancestor (inventory
pre-caveated this: "verify in AppShell.css"). Source verification: `AppShell.css:284-366` converts
the rail to a fixed off-canvas drawer (`transform: translateX(100%)`) at container ≤920px, with a
`.shell-chat-toggle` pill displayed at exactly those widths. The measured rect (x=500, w=352, no
scroll ancestor) is *precisely* the closed drawer — off-canvas by design, reachable via the
toggle. Struck from the findings table. Residual: nothing.

**2.2 — O6/W4 "pills reserve no space" is HALF WRONG.** `AppShell.css:294-296` and `423-426`
reserve a scroll-past band (`padding-bottom: calc(space-5 + 2.8rem + space-4 + safe-area)`) at
both breakpoints — content *can* clear the pills at scroll end; the occlusion in `notes-390.png`
is the normal transient state of floating pills mid-scroll. The occlusion claim is downgraded to
Low. What stands from W4: the **salience** claim — a solid-cyan Agent pill as the brightest object
on a writing screen is a real (direction-level) problem, and both prototype variants restyle it.

**2.3 — O7 "stacked drawers" UPGRADED from 'needs repro' to confirmed.** `AppShell.tsx:69-70`
holds `chatOpen` and `sidebarOpen` as independent state; each toggle (`:144`, `:158`) flips only
its own flag. Nothing closes one drawer when the other opens. The screenshot's double-✕ state is
reproducible by construction. Now finding #19, OBJECTIVE Medium.

**2.4 — Priority conflict: lens-writing says "theme first," lens-flows says "the shell mostly
stayed out of the way."** Both are right at different layers and the ranking above resolves it
deliberately: **functional absences (retrieval, data loss, off-screen pickers) outrank every
visual concern**, because no palette fixes a note you can't reopen. The theme/chrome findings
(#8–#10) remain the biggest *direction* questions — they're what the two prototype variants
exist to let David judge with his eyes rather than argue in prose.

**2.5 — Inline chip loudness vs documented intent.** `rich-text.css:128-134` records the loud
`.supertag-chip` as a deliberate "this is a structured tag" signal from the supertag-centering
pass. The review's counter-position (W12): in a prose surface the author's words should win, and
the *typeface + `#` glyph* (which that same comment says is the real signal carrier) survives a
quieter color treatment. Kept as DIRECTION, not OBJECTIVE — the variants both test the quiet
version so the comparison is visual, not rhetorical.

**2.6 — Inline fields (Tana-style) vs popover.** The comparative lens wants fields materialized
inline under the tagged block; the flows lens showed the popover model is entangled with #7
(note-level vs node-level tags). Adjudication: the *mechanical* fixes (#2 autosave, #5 anchoring,
Escape) are unconditional and should happen regardless; the inline-vs-popover decision is
**blocked on #7** and should be made after it — inline field rows only make sense attached to a
node that owns them.

---

## 3. Verdict — is "dark command-center" right for a daily-notes tool?

**No — not as the treatment of the page. Partially — as the treatment of the shell. And the
visual question is only the third most important thing this review found.**

Taking the three parts in order of honesty:

1. **The direction question is currently masked by functional gaps.** The most damaging findings
   are not aesthetic: you cannot reopen yesterday's note (#1), the supertag popover silently
   discards typed data (#2), and the `#` picker vanishes off-screen exactly where a growing daily
   note puts the caret (#4). The flows lens is right that the shell "mostly stayed out of the
   way" — a direction verdict that ignored this would be decorating a house with no stairs.

2. **On the direction itself: the command-center hypothesis fails where the product lives and
   works where it doesn't.** The evidence, not taste: the writing surface gets 45% of the screen
   at 1440px (55% chrome); the biggest type on screen is metadata; prose sits at a measured ~15:1
   on charcoal (halation territory for hours of serif reading); the layout can give the note
   *less width than its own backlinks*; and there is no light mode at all in a tool whose
   declared center is all-day prose. Every reference product whose center is writing — iA Writer,
   Bear, Ulysses, Craft — puts a paper-quiet canvas at the center and lets chrome recede;
   every one of them treats dark as a mode, not an identity. Meanwhile the command-center
   aesthetic is genuinely *good* for the periphery: graph/table views, chat, calendar, pending
   diffs — data-dense, stateful, bursty surfaces are exactly what a HUD register suits.

3. **Committed position: "the page is a page; the cockpit is the periphery."** The daily note
   should read as paper (light-capable, quiet chrome, stable ~65ch measure, one-line header,
   backlinks below); the rails and ops routes may keep the confident-command-center voice, dimmed
   one step. Dark can absolutely remain David's default — it's his tool — but it must become a
   *mode* with softened prose contrast, not the only physics the app has. The two variants below
   are the two live interpretations of that position, built to be judged side by side; and if
   after living in both David still prefers today's default, that is a legitimate outcome — but
   it will then be a decision, not a leftover from a quick three-option pick.

---

## 4. Two opt-in prototype directions (exact specs)

Both variants share one activation mechanism and one structural-fix layer, then diverge into two
genuinely different hypotheses. **With no query param, the app renders byte-identically to
today** — every rule is gated on `html[data-variant=…]`, an attribute that is never set by
default.

Scope discipline for the Prototypes stage: files touched are `packages/web/src/main.tsx`
(~10 additive lines) and two new CSS files under `packages/web/src/design-system/`. No existing
file's rules change. Class names referenced below were verified in source:
`.daily-note` / `.daily-note-eyebrow` / `.daily-note-header` / `.daily-note-date` (`app.css:360-399`),
`.sync-status-synced` (`app.css:453`), `.link-form` (`Backlinks.tsx:122`),
`.workspace-switcher-create` (`WorkspaceSwitcher.tsx:133`), `.chat-pending` / `.chat-pending-empty`
(`ChatPanel.tsx:458-463`), `.chat-create-form` (`ChatPanel.tsx:624`), `.shell-*`
(`AppShell.css`), `.supertag-chip` / `.entity-ref` (`rich-text.css:121-145`),
`.route-view` (`app.css:25`).

### 4.0 Activation (shared, main.tsx, additive)

```ts
// Design-review prototypes (2026-08-22): opt-in visual variants, inert without the param.
// ?variant=paper | ?variant=study — nothing else sets data-variant, so the default render
// is untouched.
import "./design-system/variant-paper.css"
import "./design-system/variant-study.css"
const variantParam = new URLSearchParams(window.location.search).get("variant")
if (variantParam === "paper" || variantParam === "study") {
  document.documentElement.dataset.variant = variantParam
}
```

### 4.1 Shared structural layer (~75 lines, included at the top of BOTH variant files, gated `html[data-variant]`)

These implement the fixes both hypotheses agree on (findings #3, #8, #10, #13, #20, T1, W4, O8):

```css
/* S1 — Backlinks never beside prose; kills the 46rem container-query branch and the
   razor-edge flip (findings #3: W1/W2/O1/O2/D5). Specificity (0,2,1) beats the
   container-scoped .daily-note rule (0,1,0) unconditionally. */
html[data-variant] .daily-note { grid-template-columns: minmax(0, 1fr); }

/* S2 — Chat rail becomes a summonable drawer at EVERY width (finding #8): reuses the exact
   drawer mechanics AppShell.css already defines for ≤920px containers, unconditionally.
   The toggle button is always in the DOM (AppShell.tsx renders it unconditionally); chatOpen
   state already drives open/close. Zero TSX changes. */
html[data-variant] .shell { grid-template-columns: var(--shell-sidebar-w) minmax(0, 1fr); }
html[data-variant] .shell-chat {
  position: fixed; inset-block: 0; right: 0;
  width: min(92vw, var(--shell-chat-w));
  transform: translateX(100%);
  transition: transform 0.22s var(--ease-out-quart);
  z-index: 40; box-shadow: var(--shadow-raised);
}
html[data-variant] .shell-chat-open { transform: translateX(0); }
/* W4 fix folded in: the toggle rests QUIET (surface, not solid accent) at all widths. */
html[data-variant] .shell-chat-toggle {
  display: inline-flex; position: fixed; right: var(--space-5); bottom: var(--space-5);
  z-index: 41; align-items: center; justify-content: center;
  padding: var(--space-2) var(--space-4); border-radius: 999px;
  background: var(--color-surface-raised); color: var(--color-text);
  border: 1px solid var(--color-border-strong);
  font-weight: 600; box-shadow: var(--shadow-raised);
}
html[data-variant] .shell-chat-scrim {
  display: block; position: fixed; inset: 0;
  background: var(--variant-scrim); z-index: 39;
  animation: fade-in 0.22s ease-out backwards;
}

/* S3 — Header ceremony to one line (finding #10 / W9): eyebrow gone, weekday demoted from
   49.6px display to a baseline-aligned line with the date. */
html[data-variant] .daily-note-eyebrow { display: none; }
html[data-variant] .daily-note-header {
  display: flex; align-items: baseline; gap: var(--space-3);
  margin: 0 0 var(--space-4);
}
html[data-variant] .daily-note-header h2 { font-size: var(--text-lg); font-weight: 500; margin: 0; }
html[data-variant] .daily-note-date { margin: 0; }

/* S4 — Sync is silent when successful (W7): space reserved, nothing shown. Syncing/error
   states still render. */
html[data-variant] .sync-status-synced { visibility: hidden; }

/* S5 — Docked creation forms become progressive disclosure (finding #13). CSS-only prototype
   approximation of "behind a + button": hidden at rest, revealed on hover/focus-within, so
   every feature stays reachable. (Real implementation: menus/palette.) */
html[data-variant] .workspace-switcher-create { display: none; }
html[data-variant] .shell-session:hover .workspace-switcher-create,
html[data-variant] .shell-session:focus-within .workspace-switcher-create { display: flex; }
html[data-variant] .link-form { display: none; }
html[data-variant] .backlinks:hover .link-form,
html[data-variant] .backlinks:focus-within .link-form { display: flex; }

/* S6 — PENDING CHANGES only renders when something is pending (O8). */
html[data-variant] .chat-pending:has(.chat-pending-empty) { display: none; }

/* S7 — Raw UUID out of permanent chrome (finding #20; sidebar footer only — the switcher
   option text is TSX and out of prototype scope). */
html[data-variant] .shell-workspace-id { display: none; }

/* S8 — Nav a step quieter (T1). */
html[data-variant] .shell-nav-core-item { font-size: var(--text-base); }
html[data-variant] .shell-nav-item { font-size: var(--text-sm); }

/* S9 — The empty note invites writing (finding #16). Pure-CSS placeholder: matches the
   ProseMirror empty document (single paragraph containing only the trailing break). */
html[data-variant] .rich-note-editor .ProseMirror > p:only-child:has(> br.ProseMirror-trailingBreak:only-child)::before {
  content: "What's happening today?  ·  # to tag  ·  @ to link";
  float: left; height: 0; pointer-events: none;
  color: var(--color-text-faint); font-style: italic;
}
```

Each variant file defines `--variant-scrim` in its token block below.

---

### 4.2 Variant A — **"Paper"** (`?variant=paper`): light-first, page-centered, serif-led

**Hypothesis:** the daily note is a sheet of paper in a bright room. Warm paper ground, ink
text at a comfortable (not maximal) ~12:1, the teal accent deepened to an ink register and used
only for actions/links, Space Grotesk retired from the UI (two-voice type system:
Fraunces display + Source Serif prose, system sans for incidental UI), the note **full-bleed** —
no card, no border; the page *is* the canvas. Chrome dissolves: sidebar sits on the same paper,
chat is a drawer you summon. This is the direction iA Writer/Bear/Craft argue for, tuned to keep
Athenaeum's brand hue as ink rather than HUD light.

`packages/web/src/design-system/variant-paper.css` — shared layer above, plus (~110 lines):

```css
/* ============ Variant A — "Paper" tokens ============ */
html[data-variant="paper"] {
  --hue-paper: 85;   /* warm paper */
  --hue-ink: 250;    /* slightly cool ink against warm paper */

  --color-ground: oklch(97.3% 0.007 var(--hue-paper));
  --color-surface: oklch(98.8% 0.004 var(--hue-paper));
  --color-surface-raised: oklch(100% 0 0);
  --color-surface-sunken: oklch(95% 0.008 var(--hue-paper));
  --color-border: oklch(89% 0.012 var(--hue-paper));
  --color-border-strong: oklch(58% 0.02 var(--hue-paper));   /* ≥3:1 non-text on paper */

  --color-text: oklch(30% 0.015 var(--hue-ink));             /* ~12:1 on paper — ink, not black */
  --color-text-muted: oklch(40% 0.015 var(--hue-ink));
  --color-text-faint: oklch(48% 0.012 var(--hue-ink));       /* ≥4.5:1 on paper */

  --color-accent: oklch(48% 0.085 200);                      /* deep ink-teal, AA on paper */
  --color-accent-strong: oklch(40% 0.095 200);
  --color-accent-muted: oklch(92% 0.035 200);
  --color-accent-tint: oklch(95.5% 0.02 200);
  --color-on-accent: oklch(98.5% 0.005 200);

  --color-danger: oklch(50% 0.18 27);
  --color-danger-muted: oklch(94% 0.035 27);
  --color-danger-border: oklch(70% 0.09 27);
  --color-danger-text-strong: oklch(42% 0.16 27);
  --color-success: oklch(46% 0.12 152);
  --color-success-muted: oklch(94% 0.04 152);
  --color-warning: oklch(50% 0.11 85);
  --color-warning-muted: oklch(94% 0.05 85);
  --color-warning-border: oklch(75% 0.08 85);

  --shadow-raised: 0 1px 2px oklch(40% 0.02 85 / 0.08), 0 10px 28px -16px oklch(35% 0.02 85 / 0.22);
  --variant-scrim: oklch(35% 0.02 85 / 0.35);

  /* Two-voice type system (W11): Space Grotesk retired; UI in quiet system sans. */
  --font-data: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;

  color-scheme: light;
}

/* ---- The page is the canvas (D4): full-bleed note, centered, protected 65ch measure ---- */
html[data-variant="paper"] .daily-note {
  background: transparent; border: none; box-shadow: none;
  padding: var(--space-6) 0;
}
html[data-variant="paper"] .route-view {
  margin-inline: auto;
  max-width: 40.5rem;   /* 648px = the measured-good ~65ch at 19.2px Source Serif */
}
/* Other routes keep their wider layouts */
html[data-variant="paper"] .route-view--light,
html[data-variant="paper"] .route-view:has(.graph-view),
html[data-variant="paper"] .route-view:has(.supertags-panel),
html[data-variant="paper"] .route-view:has(.share-panel) { max-width: 56rem; }

/* ---- Sidebar sits on the same paper — no separate slab ---- */
html[data-variant="paper"] .shell-sidebar { background: var(--color-ground); }
html[data-variant="paper"] .shell-session { background: transparent; border-color: var(--color-border); }

/* ---- Inline metadata one step quieter than the author's words (W12) ---- */
html[data-variant="paper"] .supertag-chip {
  background: transparent; color: var(--color-accent);
  border: 1px solid var(--color-border);
}
html[data-variant="paper"] .rich-note-editor .ProseMirror .entity-ref {
  background: transparent; color: var(--color-accent);
  padding: 0; border-radius: 0;
  text-decoration: underline;
  text-decoration-color: var(--color-border-strong);
  text-underline-offset: 3px;
}

/* ---- Scrollbars melt into the paper ---- */
html[data-variant="paper"] *::-webkit-scrollbar-track { background: transparent; }
html[data-variant="paper"] *::-webkit-scrollbar-thumb {
  background-color: var(--color-border);
  border-color: var(--color-ground);
}
```

### 4.3 Variant B — **"Study"** (`?variant=study`): the command-center refined — dark kept, everything measured fixed

**Hypothesis:** dark is the right personal default; the failure was execution, not the idea. The
charcoal/teal identity, Space Grotesk voice, and bordered-panel language stay — but prose drops
from ~15:1 to a measured ~11:1 (a new `--color-prose` token, UI text untouched), the note becomes
a *centered, stable, measured* page (rail summoned, never resident; measure capped at ~68ch and
immune to scrollbars), the header is one line, inline metadata dims to outline chips, and every
piece of resident administrative furniture from the findings recedes. If this variant wins, the
command-center direction survives — as a considered decision this time.

`packages/web/src/design-system/variant-study.css` — shared layer above, plus (~55 lines):

```css
/* ============ Variant B — "Study" tokens ============ */
html[data-variant="study"] {
  /* Prose-only contrast drop: ~15:1 → ~11:1 (W5). UI text keeps --color-text. */
  --color-prose: oklch(86% 0.02 var(--hue-warm));
  /* Inline refs dim half a step (W12) without losing the accent identity. */
  --color-accent-strong: oklch(78% 0.12 200);
  --variant-scrim: oklch(8% 0.01 var(--hue-neutral) / 0.55);
}

html[data-variant="study"] .daily-note-body,
html[data-variant="study"] .rich-note-editor .ProseMirror { color: var(--color-prose); }

/* ---- The note is a centered, measured page on the dark ground (findings #3/#10).
   With the rail summoned (shared S2), main gains 352px — cap and center the column so the
   measure lands ~68ch and NEVER re-flows from scrollbar noise. Card border kept: that is
   this variant's identity claim, now earning its keep as the page's frame. ---- */
html[data-variant="study"] .route-view { margin-inline: auto; max-width: 46rem; }
html[data-variant="study"] .daily-note { padding: var(--space-6); }

/* ---- Inline metadata: outline chips, accent reserved for interaction (W12) ---- */
html[data-variant="study"] .supertag-chip {
  background: transparent; color: var(--color-accent);
  border: 1px solid var(--color-accent-muted);
}
html[data-variant="study"] .rich-note-editor .ProseMirror .entity-ref {
  background: transparent; color: var(--color-accent); padding: 0;
}

/* ---- The tunnel opens (T2/T3): sidebar loses its slab edge; scrollbar tracks vanish ---- */
html[data-variant="study"] .shell-sidebar { background: var(--color-ground); border-right-color: transparent; }
html[data-variant="study"] *::-webkit-scrollbar-track { background: transparent; }
html[data-variant="study"] *::-webkit-scrollbar-thumb { border-color: var(--color-ground); }
```

### 4.4 What the variants deliberately do NOT touch

Findings #1 (retrieval), #2 (autosave), #4/#5 (picker/popover positioning), #7 (tag semantics),
#11 (composer-first chat), #12/#14 (schema manager), #17 (graph), #19 (drawer exclusivity) are
**behavioral, not skinnable** — they need TSX work and, for #7, a product decision. They are the
top of the fix queue regardless of which visual direction wins, and no prototype should be read
as addressing them.

### 4.5 How to judge the prototypes

Load `:3000/?variant=paper` and `:3000/?variant=study` side by side against the unparametered
default. Spend a real writing session (not a glance) in each: the questions are "which surface
do I want to live in for hours?", "does the quiet chrome cost me anything I actually used?", and
"does dark-as-identity survive contact with dark-done-carefully?" — then pick a direction, and
the losing variant's structural layer (S1–S9) still applies to the winner: those fixes are
direction-independent.

# Lens 4 — Task-Flow Walkthroughs

Driven live against `:3000` on 2026-08-22 in the isolated `design-review` browser context
(design-review@rawkode.academy, shared workspace `089db7a6`), desktop 1440×900. Every claim below
was performed, not inferred; measurements are from the live DOM. Screenshots: `flow-*.png` in this
directory.

Severity scale: **Critical** (defining task fails) / **High** (daily-frequency pain or silent data
loss) / **Medium** (repeated friction) / **Low** (annoyance).

---

## Flow 1 — Morning open → write three lines → tag a person with `#` → fill one field

**Steps as executed:**

| # | Action | Cost |
|---|--------|------|
| 1 | Load `http://localhost:3000/` (redirects to `/notes`) | ~1s dev load |
| 2 | Click into editor to focus + place caret | **1 click** |
| 3 | Type three lines | typing |
| 4 | Type `#` | 1 key — **picker opens fully off-screen** (see F1.2) |
| 5 | Type `Per`, press Enter | 4 keys — tag applied, chip inserted, field popover auto-opens |
| 6 | Click email field, type value | 1 click + 16 keys |
| 7 | Press Enter to commit | **silently does nothing** (see F1.4) |
| 8 | Click that field's `Save` | 1 click — no confirmation feedback |
| 9 | Click `✕` to close popover (Escape doesn't work) | 1 click |

Net: 4 clicks beyond typing — not many, but **three of the nine steps fail silently or invisibly**.
Nothing is modal; the editing surface itself is calm. The stumbles are all in the supertag machinery.

### Findings

**F1.1 — OBJECTIVE, Medium — Editor does not autofocus on open.**
After load, `document.activeElement` is `BODY`. Typing on arrival goes nowhere; the first act of
every morning is a mouse click. iA Writer and Bear put the caret in the document on open; Reflect
focuses today's note. For an all-day capture tool the zero-click "arrive and type" path is table
stakes. (flow-1-open.png)

**F1.2 — OBJECTIVE, High — The `#` picker renders entirely below the viewport when the caret is low.**
Measured: caret at ~y 860 in a 900px viewport → menu `.rich-supertag-menu` placed at top=899,
bottom=1155 (240×256px) — 1px visible. It never flips above the caret. flow-1-hash-picker.png shows
the real user experience: `#` typed, nothing visibly happens. Since a daily note grows downward all
day, the caret lives in the bottom third precisely when tagging happens most — this will bite
constantly, and it reads as "the feature is broken", not "scroll down". (Filtering and selection
still work blind — I typed `Per` + Enter and it applied — but only because I knew the menu existed.)

**F1.3 — OBJECTIVE, High — The field popover is pinned to the bottom-right corner, not anchored.**
Measured across three opens (typed-`#` apply, chip click, second tag apply): `.supertag-popover`
always at x=1088–1408, bottom=868 — i.e. fixed 32px from the viewport's right/bottom corner,
regardless of what opened it. From a caret at the bottom-left of the prose column that is ~700–900px
of eye travel, and the popover sits **on top of the agent chat rail**, hiding its lower half
(flow-1-after-apply.png, flow-2-book-applied.png). Popovers should anchor to their invoker (chip or
caret) with flip logic — cf. Notion's property editing, Craft's inline panels.

**F1.4 — OBJECTIVE, High — Enter in a field input does not save; closing discards silently.**
Verified: typed `alex@example.com` into email, pressed Enter, closed popover, reopened — field
empty. Value was lost with no warning. Each field requires its own explicit `Save` click, clicking
`Save` gives no feedback (no toast, no flash, button unchanged), and there is no dirty-state guard
on close. Enter-to-commit is the universal convention; this is the most likely silent data-loss
point in daily use. (Persistence with explicit Save verified working — flow-1-field-saved.png.)

**F1.5 — OBJECTIVE, Medium — Escape does not close the popover.** Only the small `✕` or `Remove tag`
do. Keyboard flow dies at the popover.

**F1.6 — DIRECTION, High — "Tag a person inline" doesn't actually exist: supertags attach to the whole note.**
When I applied `#Person` next to "Alex", the auto-opened popover already contained
`role = Platform Engineer` — the value saved two days earlier for the note-level `#Person`
application. Both inline chips and the "Supertags on this note" region point at **one** tag instance
on the daily note. Semantically, the daily note itself *is* the Person; Alex has no node, no
identity, and tagging a second person is impossible without corrupting the first one's fields. In
Tana — the explicit reference model for supertags — a tag attaches to the *node* (bullet), so
tagging "Alex #person" mints an Alex object with its own fields, reusable across days. This is the
single deepest product-model question the flows surfaced, and it's David's call: either supertags
become node/block-level, or the inline `#` affordance is misleading and should visibly read as
"tags this note".

**F1.7 — OBJECTIVE, Medium (live confirmation of inventory finding) — the note layout flip-flopped
mid-session.** Flow 1 screenshots show the narrow two-column state (294px prose); by Flow 2, same
window, same viewport, it was wide single-column (flow-1-hash-picker.png vs flow-2-apply-picker.png).
The `@container` breakpoint sitting 8px from the actual container width means scrollbar appearance
alone re-layouts the whole page while you work.

---

## Flow 2 — Define a NEW supertag with two fields via /supertags, then apply it

**Steps as executed:** Supertags nav (1 click) → name "Book" (click + 4 keys) → `+ Create tag`
(1 click; **new tag auto-selected, fields panel opens — good**) → field "author": click, 6 keys,
`Add` (1 click) → field "rating": click, 6 keys, type dropdown → number (2 clicks), `Add` (1 click)
→ `Today` (1 click) → click end of note, type `…#Boo` → Enter → popover opens with author/rating →
fill author → `Save`. **≈10 clicks + typing for the full round trip.**

### Verdict: the round trip is coherent — the two ends just don't know about each other.

The new tag appeared in the `#` picker immediately, with correct fields in the popover, no refresh
(flow-2-apply-picker.png shows `#Book` as first suggestion; flow-2-book-applied.png shows
author/rating live in the note). No context was lost. This is the best-executed flow of the five.

**F2.1 — OBJECTIVE, Medium — Schema is write-only.** The tag detail panel (flow-2-book-defined.png)
offers no way to delete a tag, rename it, edit/remove a field, or change parents after creation
("Parents — (a root tag)" is static text; the parent checkboxes only apply at creation time). Every
experiment is permanent — my test `#Book` now lives in David's picker forever. A type system you
can't refactor punishes exactly the exploratory use it's meant to invite.

**F2.2 — DIRECTION, Medium — The trip to /supertags was unnecessary, and nothing tells you so.**
The in-note popover has its own `+ Add field` with the full type dropdown, and the `#` picker has
`Create "#X" (new)` — the whole task could have been done without leaving the note. But the two
schema-editing surfaces never reference each other, so the user learns the heavyweight path.
Decision for David: make the in-note path the taught path (Tana-style, everything from the tag), and
reposition /supertags as the schema *browser* — or remove field editing from the popover to keep one
source of truth.

**F2.3 — TASTE, Low — The "Parents (optional — inherits their fields)" checkbox block reads as a
list filter.** It sits between the create form and the tag list and stays visible at all times, but
only affects the next created tag (flow-2-book-defined.png).

---

## Flow 3 — Find something from a previous day

### Verdict: OBJECTIVE, **Critical** — retrieval does not exist. Not buried: absent.

Every avenue was tried, in the order a user would:

1. **Search:** No search input anywhere in the shell (verified: zero `input[type=search]` or
   search-placeholder inputs in the DOM). **Cmd+K and Ctrl+K do nothing** — no command palette, no
   dialog. The app's complete link inventory is the 9 sidebar routes; there is no `/search`.
2. **Calendar:** Today-only. The page renders "TODAY — 2026-08-22" plus a Google Calendar connect
   prompt. No month grid, no previous/next day, no date picker.
3. **Graph:** A read-only table ("Browse nodes tagged across this workspace via a read-only compiled
   view"), and **node titles are plain `StaticText` — not clickable**. The only per-row action is
   "+ Person" (applies a tag!). You can see that "Daily Note — 2026-08-22" exists and cannot open
   it. (flow-3-graph-no-links.png)
4. **Mentions in the note body:** `span.entity-ref`, `cursor: text`, no handler, no href — styled in
   the same teal as links, but inert. Link-colored text that goes nowhere is worse than no styling:
   it teaches users that "links" here don't work.
5. **Backlinks section:** entries are `<strong>` text — also not clickable.

Net: **the UI has no route to open yesterday's daily note, or any node other than today's.** The
sidebar item is literally named "Today", and Today is the only document in the product. Writing has
an all-day surface; reading back has none. For a tool whose stated center is daily notes, this
inverts the point of keeping them — notes you can never revisit are a chat log. Every comparable
tool treats retrieval as a primary surface: Bear and Craft keep persistent search above the note
list; Reflect and Logseq give daily notes prev/next-day navigation and backlink-first recall; Tana
has search nodes; Notion at minimum has Cmd+P search. Athenaeum currently has none of these — the
only theoretical retrieval path is asking the agent, which (Flow 4) cannot reply.

This is the flows' #1 finding and should outrank every visual concern in the review.

---

## Flow 4 — Agent chat, no-model state

**Steps:** typed into "Message the agent", clicked Send → reply appeared in ~3s (flow-4-no-model.png):

> **No AI model configured.** Your message was saved, but the agent can't reply yet — the backend
> has no `ANTHROPIC_API_KEY` configured (expected in this environment; see the report accompanying
> this build). Configure one with `wrangler secret put ANTHROPIC_API_KEY` against the `backend`
> Worker to enable real replies.

**What works:** distinct amber error styling (clearly not a normal agent bubble); honest about what
happened; says the message was saved; names the exact cause and fix. As developer-facing copy this
is genuinely good.

**F4.1 — OBJECTIVE, Medium — The error reply is ephemeral; unanswered messages accumulate silently.**
After navigating to /apps and back, the chat shows both of my YOU messages with *no* reply and no
explanation (visible in flow-5-app-launched.png's rail). A user returning later sees a chat that
looks ignored. The no-model notice (or a persistent "agent offline" banner on the rail) should
survive navigation.

**F4.2 — DIRECTION, Medium — The remedy is a CLI command inside end-user chat UI.** `wrangler secret
put` is the right sentence for David-the-developer and the wrong register for a product surface.
There is no settings/onboarding surface where a model could be configured; the chat rail is
permanently docked (352px, ~24% of the viewport) for a feature that currently cannot function.
Decision for David: either a real "connect a model" setup state, or the rail shouldn't be
permanently open in this state.

**F4.3 — TASTE, Low — "see the report accompanying this build"** references a document that isn't
linked or reachable from the app; dead-end microcopy.

**F4.4 — OBJECTIVE, Low — The error box overlaps the message above it**, clipping "Summarise my day
so far in…" (flow-4-no-model.png).

---

## Flow 5 — Launch an App and come back

**Steps:** Apps (1 click) → "Seed test Counter app (dev)" (1 click — seeds *and* launches) → clicked
`+1`, counter incremented 0→1 (app genuinely runs) → `← Apps` (1 click) → `Today` (1 click). Note
content fully intact on return; agent chat rail persists across the whole trip. **4-click round
trip, zero surprises — the smoothest flow of the five.**

**F5.1 — OBJECTIVE, Low — No layout contract for launched apps.** The Counter renders as a tiny
unstyled `+1` in the top-left of an otherwise empty ~1000×700 dark panel (flow-5-app-launched.png).
Fine for a dev seed; real agent-authored apps will need a sizing/padding/theme contract or every
app will look broken on arrival.

**F5.2 — TASTE, Low — The library speaks architecture, not utility.** "each runs in a genuinely
sandboxed Worker Loader isolate" is the lead sentence of the empty state; a returning user cares
what apps *do*, not where they run. (Overlaps the microcopy lens.)

---

## Summary table

| ID | Flow | Class | Severity | Finding |
|----|------|-------|----------|---------|
| F3.* | Retrieval | OBJECTIVE | **Critical** | No search, no command palette, today-only calendar, non-clickable graph rows, inert mentions/backlinks — no way to open any note but today's |
| F1.2 | Capture | OBJECTIVE | High | `#` picker renders fully off-screen when caret is in bottom ~250px (no flip) |
| F1.3 | Capture | OBJECTIVE | High | Field popover fixed to bottom-right corner (measured 32px margins), covers chat rail, never near its anchor |
| F1.4 | Capture | OBJECTIVE | High | Enter doesn't save field values; close silently discards; Save gives no feedback |
| F1.6 | Capture | DIRECTION | High | Supertags are note-level only — "tagging a person" retags the whole daily note; one shared field set per tag per note (vs Tana's node-level tags) |
| F1.1 | Capture | OBJECTIVE | Medium | No editor autofocus on morning open |
| F1.5 | Capture | OBJECTIVE | Medium | Escape doesn't close the popover |
| F1.7 | Capture | OBJECTIVE | Medium | Live layout flip between 1/2-column states mid-session (container breakpoint) |
| F2.1 | Schema | OBJECTIVE | Medium | Tags/fields/parents cannot be edited or deleted after creation — schema is write-only |
| F4.1 | Agent | OBJECTIVE | Medium | No-model error reply not persisted; old messages sit unanswered with no explanation |
| F2.2 | Schema | DIRECTION | Medium | Two disconnected schema-editing surfaces; the in-note path can do everything but is untaught |
| F4.2 | Agent | DIRECTION | Medium | Model setup is a CLI instruction in chat; no settings surface; rail permanently docked while non-functional |
| F4.4 | Agent | OBJECTIVE | Low | Error box overlaps preceding message bubble |
| F5.1 | Apps | OBJECTIVE | Low | No sizing/theme contract for launched app iframes |
| F2.3 | Schema | TASTE | Low | Parent checkboxes read as a list filter |
| F4.3 | Agent | TASTE | Low | "see the report accompanying this build" — unlinked dead-end copy |
| F5.2 | Apps | TASTE | Low | App Library empty state leads with sandbox architecture, not user value |

**What the flows say about the direction question:** the visual shell mostly stayed out of the way —
the pain is concentrated in (a) a missing retrieval surface, (b) supertag interaction mechanics
(positioning, save model), and (c) the note-level-vs-node-level tag semantics. If only three things
change from this lens: add search/back-navigation for daily notes, anchor + auto-save the supertag
popover, and decide F1.6 deliberately.

## Screenshot index

- `flow-1-open.png` — fresh morning load; editor unfocused
- `flow-1-hash-picker.png` — `#` typed at bottom of note; picker exists at y=899 but nothing visible
- `flow-1-after-apply.png` — tag applied; popover in bottom-right corner over the chat rail, caret bottom-left
- `flow-1-field-saved.png` — email filled + Save clicked; note the absence of any confirmation
- `flow-2-book-defined.png` — /supertags with #Book (author/rating); no delete/edit affordances
- `flow-2-apply-picker.png` — `#Boo` picker correctly visible mid-viewport with new tag first (also shows wide layout state vs flow-1's narrow)
- `flow-2-book-applied.png` — #Book chip + popover with author/rating in the note
- `flow-3-graph-no-links.png` — graph table; title text non-clickable, only action "+ Person"
- `flow-4-no-model.png` — amber no-model reply, full copy; box overlapping message above
- `flow-5-app-launched.png` — Counter app running in launch view; empty-panel layout; unanswered chat messages in rail

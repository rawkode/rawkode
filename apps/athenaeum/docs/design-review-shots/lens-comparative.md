# Lens 3 — Comparative teardown

Surface-by-surface comparison against the genuine best-in-class for each surface. Competitor
behavior is described **from memory** of those products and marked as such; nothing below invents a
specific competitor UI detail I'm not confident of. Every Athenaeum claim cites a screenshot in this
directory or a measured value from `inventory.md`.

Classes: **OBJECTIVE** (measurable defect / clearly worse than the reference), **DIRECTION**
(defensible either way, needs David's call), **TASTE** (labeled as such).
Severity: **High / Medium / Low** — how much daily pain it causes for an all-day personal tool.

---

## 1. Daily note — vs. Craft, Bear, Reflect

Evidence: `notes-1440.png`, `notes-backlinks-1440.png`, `notes-empty-1440.png`, `notes-390.png`,
`inventory.md` (294px prose / ~28 chars per line; 46rem container query 8px under the 744px container).

**Biggest gap: there is no way to reach any day other than today.** Every daily-note app in the
reference class treats the daily note as one page in an infinite sequence: Reflect (from memory)
puts prev/next arrows and a calendar beside the daily note; Craft (from memory) has a calendar
strip/date navigator for daily notes; even Obsidian's daily-notes plugin ships prev/next commands.
In every screenshot the note header is `DAILY NOTE / Saturday / 2026-08-22` with **no back/forward
affordance, no calendar strip, no date picker** — the only nav entry is "Today" (`notes-1440.png`,
left sidebar). Yesterday's note — the thing an all-day daily-notes user opens most after today's —
is unreachable from the UI. This is the single largest functional gap in the whole app relative to
its own product framing ("centered on daily notes").

- Class: **OBJECTIVE**. Severity: **High**.
- One change that closes most of it: prev/next chevrons flanking the date in the note header plus a
  small month popover on the date itself (Reflect's pattern, from memory). No new routes needed —
  `/notes/:date`.

**Second gap: the writing column loses to its own metadata.** Bear and iA Writer (from memory) are
built around one principle: the text column is sacred — 45–70 characters, everything else recedes.
Craft keeps backlinks/metadata *below* the document. Athenaeum's two-column state
(`notes-backlinks-1440.png`) gives prose **294px (~28 chars/line)** and the Backlinks sidebar
**320px** — the note is narrower than its appendix, on a 1440px screen where the shell has already
spent 600px on sidebar + chat rail. And per `inventory.md` the layout flips between one and two
columns on an 8px margin (scrollbar appears → whole page reflows). No reference app ever lets
backlinks compress the editor.

- Class: **OBJECTIVE** (measured; violates every readability target). Severity: **High**.
- One change: backlinks never share a row with prose. Below the note (Craft's placement, from
  memory) or a collapsible panel. This also deletes the razor-edge container query.

**Third gap: heavyweight capture UI where the references use typing.** In Reflect and Roam (from
memory), linking is done by typing `[[` — there is no persistent form. Athenaeum's daily note
carries a permanent `New node title — links here as a backlink` input + `Create + link` button
inside the Backlinks section (`notes-1440.png`), i.e. database-admin UI embedded in a journal page.
The `@` mention picker already exists (`notes-mention-picker-1440.png`) and is the right mechanism.

- Class: **DIRECTION** (the form is a second, redundant path). Severity: **Medium**.
- One change: delete the form; keep `@`/`[[` creation in the editor, with a "create node" row in the
  picker for unmatched text.

Minor: the empty note (`notes-empty-1440.png`) shows no placeholder text in the editor area — Craft
and Reflect (from memory) show a ghost prompt where you'll type. Class: OBJECTIVE (missing
affordance — the click target is invisible). Severity: Low. Change: `Write, or type # / @ …`
placeholder in the ProseMirror.

---

## 2. Supertag application + field popover — vs. Tana (the direct inspiration)

Evidence: `notes-tag-picker-1440.png`, `notes-field-popover-1440.png`, `notes-1440.png`.

How Tana does it (from memory): you type `#tag` on a **node** (a block/outline item); the tag pill
attaches to that node; the tag's fields materialize **inline, indented directly under the node** as
`field:: value` rows you Tab through and fill in place. No popover, no save button — everything is
live. The supertag's fields are part of the document flow, which is exactly why Tana's supertags
feel like "a database hiding inside your notes."

Athenaeum's version falls short in three compounding ways:

1. **Fields live in a popover, not inline.** `notes-field-popover-1440.png` shows role/email/company
   in a floating panel — the structured data never becomes part of the note. You fill it blind, close
   it, and the note shows only a pill.
2. **The popover is anchored to the wrong place.** In the screenshot it renders in the
   **bottom-right corner of the viewport, overlapping the chat rail**, while the `#Person` pill it
   configures sits mid-document and the "Supertags on this note" tray pill sits bottom-left of the
   note. There is no visual connection between trigger and editor.
3. **Per-field Save buttons.** Three fields → three `Save` buttons plus an `Add` for new fields.
   Tana (and Notion, and every modern field editor, from memory) commits on blur/Enter. Explicit
   per-row Save is form-builder UI from a different decade and triples the interaction cost of
   filling a contact card.

There's also a model ambiguity Tana doesn't have: the pill appears **in the text** ("Coffee chat
notes with the team. `Person`", `notes-1440.png`) *and* in a note-level "Supertags on this note"
tray — it reads as if the tag applies to the whole daily note rather than to the block/entity you
typed it on. In Tana the tag unambiguously belongs to the node you typed it on.

- Biggest gap: **fields not inline** — the core Tana magic is missing. Class: **DIRECTION** on
  inline-vs-popover (popover is defensible in a prose editor, unlike Tana's outliner), but
  **OBJECTIVE** on anchor position and per-field Save. Severity: **High** (this is the product's
  named centerpiece).
- One change that closes most of it: when a tag is applied, render its fields as a live-editing
  card **attached to the pill's block** (expand/collapse under the paragraph, Tab between fields,
  save on blur). Kill all Save buttons. If the popover stays, anchor it to the pill.

Minor: the `#` picker (`notes-tag-picker-1440.png`) shows bare tag names only — Tana's picker (from
memory) shows a create-new option and enough context to distinguish tags. Low, TASTE-adjacent.

---

## 3. Supertag management — vs. Tana schema config / Notion database schema editing

Evidence: `supertags-1440.png`, `supertags-empty-1440.png`.

The Supertags route is a **flat name list** (`#Area BASE`, `#Company BASE`, …) beneath a
permanently-expanded creation form whose "Parents (optional — inherits their fields)" is a grid of
eight checkboxes. What the reference class does (from memory): Notion's schema editor lists
**properties with their types**, edited inline, reorderable; Tana's supertag config shows the
tag's fields, inherited fields, defaults, and where it's used. In both, *the schema is the content
of the screen*.

Here the schema is invisible. The list rows show a name and an unexplained `BASE` badge — no field
names, no field count, no inheritance line, no usage count ("3 nodes tagged"). The route's own
subtitle says the point is "define the fields it (and everything beneath it) carries," but fields
are the one thing the screen doesn't show. Field editing evidently lives somewhere behind the row
(per the route inventory), while the eight-checkbox parent picker — a *creation-time* concern —
permanently occupies the prime top-of-page position even when you're not creating anything.

- Biggest gap: **schema-less schema manager** — you cannot answer "what does #Person carry?" from
  the management screen. Class: **OBJECTIVE** (information absent, jargon badge). Severity:
  **Medium-High**.
- One change: make each row show its fields inline (chips: `role · email · company` + `↑ inherits
  from #Person`), expanding to Notion-style inline property editing; collapse the creation form to a
  single `+ New Supertag` button (progressive disclosure — the checkboxes appear only after you
  name the tag). Rename or tooltip `BASE`.

---

## 4. Graph / table views — vs. Notion databases / Airtable

Evidence: `graph-1440.png`.

The route is labeled **"KNOWLEDGE GRAPH / Graph"** but renders a read-only three-column table:
`ID / TITLE / CREATED`, one row, a checkbox hard-coded to `Only nodes tagged "Person"`, and debug
chrome leaking through (`graph_nodes · VIA runView`, ID rendered as `00000000`).

Against the reference class this misses on every axis (from memory): Airtable/Notion tables put
**user data in the columns** — here that means supertag fields (role, email, company), which is the
entire payoff of defining fields; they offer **per-column sort/filter**, not one pre-baked checkbox
for one tag; they support **grouping and multiple views**; and they never show internal row IDs.
`00000000` and `VIA runView` are implementation residue with zero user value. Separately, "Graph"
is a misleading name: in this category (Obsidian, Roam, from memory) "graph" means a node-link
visualization; users arriving here expecting one get a table.

- Biggest gap: **a table of typed nodes that shows none of their types' fields** — the supertag
  system's query payoff doesn't exist yet. Class: **OBJECTIVE** (ID column, debug caption,
  hard-coded single-tag filter); the table-vs-visual-graph choice itself is **DIRECTION** (a table
  is arguably more useful — but then name it "Nodes" or "Database"). Severity: **Medium** today
  (little data), **High** the moment supertags get real use.
- One change: pick a tag → columns become that tag's fields, sortable; drop ID/`runView`; rename
  the route. That single change turns Supertags from decoration into a queryable database (the
  Tana/Notion promise).

---

## 5. Agent chat — vs. best chat-panel implementations (Cursor, Claude/ChatGPT sidebars)

Evidence: `chat-rail-1440.png`, `notes-1440.png` (empty rail), `chat-rail-390.png`.

The reference pattern (from memory — Cursor's chat pane, ChatGPT/Claude): **composer pinned at the
bottom, thread above it, a `+` icon for a new chat, titles auto-generated from the first message,
and the whole panel toggleable**. Nobody makes you name a conversation before it exists.

Athenaeum inverts nearly all of this:

- **Title-first creation**: the rail leads with a `New chat title` input + `New chat` button at the
  *top*; in the empty state (`notes-1440.png`) that form plus "Create a chat to get started." *is*
  the interface. You must invent a name ("Plan my day") before you can ask anything.
- **Permanent 352px dock**: the rail occupies ~25% of a 1440px screen on every route, even when it
  contains only "No chats yet." — while the daily note's prose column starves at 294px
  (`notes-backlinks-1440.png`). Cursor's panel (from memory) collapses to nothing when unused.
- **Dead vertical middle**: in `chat-rail-1440.png` one user bubble sits at top, the composer at
  the bottom is fine, but the `PENDING CHANGES` section with its explanatory sentence ("Nothing
  pending — accepted or reverted changes disappear from here.") is permanently rendered even when
  empty — chrome explaining its own absence.

The diff-review concept itself (pending changes you accept/revert) is genuinely good and ahead of
most chat panels — it's the packaging that lags.

- Biggest gap: **creation flow backwards + always-on footprint**. Class: **OBJECTIVE** for
  title-before-message (no reference product does this; it adds a naming task before value);
  **DIRECTION** for permanently-docked vs. collapsible (the .impeccable.md hypothesis under
  attack — an all-day companion rail is defensible, but it must earn 25% of the screen).
  Severity: **High**.
- One change: composer-first — an empty rail shows only "Message the agent…"; sending creates the
  chat and auto-titles it; add a collapse toggle on the rail and hide `PENDING CHANGES` until
  something is pending.

---

## 6. App Library — vs. iOS home screen / Arc's new-tab surface

Evidence: `apps-1440.png`.

The screen is: eyebrow `SANDBOXED`, title, subtitle "each runs in a genuinely sandboxed Worker
Loader isolate", a second full paragraph about Worker Loader isolates and ambient access, one
dashed `New App` tile, and a dev seed button with three more lines about "the same mainline path an
agent turn would."

The reference class (from memory): iOS shows a grid of icons with names — the security
architecture (App Sandbox) is never mentioned in the launcher; Arc's surfaces stay visual and
content-first. The principle they share: **a launcher sells what apps do, not how they're
isolated.** Here the *headline* is the isolation tech — "SANDBOXED" is the eyebrow where every
other route puts the user-facing category ("QUICK CAPTURE", "TODAY'S SCHEDULE"). Two of the three
text blocks on the page describe implementation. For David-as-user (not David-as-builder-demo) the
questions are "what apps do I have, what could I make?" — and the empty state answers neither: no
example apps, no suggested prompts ("Build me a habit tracker"), just an empty tile.

- Biggest gap: **architecture-forward, benefit-absent presentation**. Class: **OBJECTIVE** for the
  microcopy (headline describes plumbing; users' first question unanswered); **TASTE** on how much
  the sandbox story deserves a one-line mention (it *is* a trust point). Severity: **Medium** (low
  traffic today, but it's the surface meant to show the agent's superpower).
- One change: eyebrow → something user-facing ("YOUR TOOLS"); demote the isolate copy to one
  reassurance line ("Apps run sandboxed — no access to your data unless you grant it"); fill the
  empty state with 3–4 one-tap example prompts that generate starter apps.

---

## 7. Empty states — vs. Linear's

Evidence: `notes-empty-1440.png`, `bookmarks-empty-1440.png`, `supertags-empty-1440.png`,
`meetings-1440.png`, `workouts-1440.png`, `calendar-1440.png`, `sharing-1440.png`.

Linear's empty states (from memory) follow a strict recipe: centered, a small illustration/icon,
one short benefit line, a primary action button (often with its keyboard shortcut) — the empty
state *is* an onboarding step. Athenaeum's empty states are left-aligned prose sentences in muted
text, no icon, no button:

- Bookmarks: "No bookmarks yet — paste a URL above." (points at a form; acceptable but flat).
- Meetings / Workouts (`meetings-1440.png`, `workouts-1440.png`): the empty state is a
  **four-line architecture paragraph** — "system-audio capture, on-device speech recognition with a
  cloud fallback", "a real Swift WorkoutDataSource pipeline" — followed by a bare `Refresh` button
  and "No meetings recorded yet." A user who opens Meetings learns about the transcription stack
  but not the one thing Linear would tell them: *what to do next on which device*.
- Calendar: single sentence + `Connect Google Calendar` button — closest to correct; the button
  just lacks prominence (secondary-styled, below the fold of the section).
- **Sharing (`sharing-1440.png`) shows raw error strings as its default state**: "This workspace
  doesn't exist (or was deleted)." in red, twice, under Collaborators and Share links — on a
  workspace that manifestly exists (the rest of the app is using it). Whatever the backend cause,
  shipping an error sentence as the steady-state empty state is a defect Linear's pattern
  (explicit empty vs. error designs) exists to prevent.
- Chat: the "empty state" is a form to fill in (see §5).

- Biggest gap: **empty states describe the system instead of directing the user** — and one of
  them is an unhandled error. Class: **OBJECTIVE** for Sharing's error-as-empty-state (High) and
  for meetings/workouts implementation-copy (Medium); **TASTE** on whether Athenaeum should adopt
  Linear's icon-plus-CTA visual formula or keep its quieter text-only voice.
- One change: a single `EmptyState` component (icon, one benefit line, one CTA) rolled out to all
  routes, with error states rendered distinctly from empty ones; rewrite meetings/workouts copy to
  a next-action ("Record from the macOS app — transcripts appear here").

---

## Summary table

| Surface | Biggest gap vs. reference | Class | Severity | One closing change |
|---|---|---|---|---|
| Daily note | No navigation to any other day | OBJECTIVE | High | Prev/next + date popover in note header |
| Daily note layout | 294px prose beside 320px backlinks; 8px-margin layout flip | OBJECTIVE | High | Backlinks below/collapsible, never beside prose |
| Supertag application | Fields in a mis-anchored popover with per-field Save, not inline | OBJECTIVE (anchor, Save) / DIRECTION (inline) | High | Live-save field card attached to the pill's block |
| Supertag management | List shows names, never the schema | OBJECTIVE | Med-High | Fields inline per row; creation behind `+ New Supertag` |
| Graph | Typed nodes shown without their fields; debug chrome; misnamed | OBJECTIVE / DIRECTION (name) | Med (→High) | Tag-scoped field columns, sortable; rename route |
| Agent chat | Title-before-message creation; permanent 352px dock | OBJECTIVE / DIRECTION (dock) | High | Composer-first + auto-title + collapsible rail |
| App Library | Headline is the sandbox tech, not what apps do | OBJECTIVE (copy) / TASTE | Med | Benefit copy + example-app prompts in empty state |
| Empty states | Describe architecture (or leak errors) instead of directing action | OBJECTIVE | High (Sharing) / Med | Shared EmptyState component; error ≠ empty |

Pattern across all seven surfaces: **the references invest their pixels in the user's content and
next action; Athenaeum invests a large share of its pixels in its own machinery** (creation forms
always expanded, architecture explanations, IDs/UUIDs, sections announcing their own emptiness).
Closing that one habit closes most of this lens.

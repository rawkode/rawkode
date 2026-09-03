# Lens 2 — Information architecture & layout (adversarial)

Evidence: screenshots in this directory + measurements in `inventory.md` (all values below are
from those two sources; comparisons to other products are from general product knowledge and
describe patterns, not pixel-precise claims). Viewport for desktop numbers: 1440×900.

Shell budget at 1440: sidebar **248px (17.2%)** + main **840px (58.3%)** + chat rail
**352px (24.4%)**. Inside main, the note card is 744px wide with 48px internal padding →
**648px** of usable writing width in the single-column state, **294px** in the two-column state.

Severity scale: P0 = actively breaks the core use, P1 = costs the user daily, P2 = real but
bounded, P3 = worth fixing when touching the area.

---

## OBJECTIVE defects

### O1 · P0 — In the two-column note state, the prose column is the narrowest thing on screen
`notes-backlinks-1440.png`; measured grid `294px prose + 32px gap + 320px backlinks`
(inventory §"Measured prose column").

At 19.2px Source Serif, 294px is **~28 characters per line** (readability floor is usually
quoted at 45; comfortable is 60–75). Rank-ordering the columns on the core writing screen:
chat rail 352px > backlinks 320px > **prose 294px**. On a product whose stated center of
gravity is the daily note, the layout gives the writing surface less width than either of its
two metadata sidecars. The screenshot shows the visible symptom: "Follow up on the GPU cluster
quote" wraps at 4–5 words, and the `Person` chip plus a date link fills two full lines.
This is not a taste call — 28ch serif prose is objectively degraded reading and writing.

Fix directionally coupled to D5 (put backlinks below, never beside), which deletes O1 and O2
at once.

### O2 · P0 — The daily-note layout flips between one and two columns on an 8px knife edge
`notes-1440.png` (single-column) vs `notes-backlinks-1440.png` (two-column) — **both captured
at the same 1440×900 window** (inventory §"Razor-edge breakpoint").

Container = 744px; `@container notes (min-width: 46rem)` = 736px; margin = 8px. Anything that
shaves ≥9px — a scrollbar appearing when content grows past a viewport, an OS overlay-scrollbar
setting — flips the entire page between two fundamentally different layouts. The core screen of
the app is nondeterministic at a common laptop width. This is a defect independent of which
layout is "right": a breakpoint must not sit inside the noise band of scrollbar width.

### O3 · P1 — Between ~500px and the mobile breakpoint, the chat rail renders off-viewport and unreachable
Inventory §"Responsive behavior": at a 500px window, rail rect x=500 w=352 with
`window.innerWidth`=500 and **no scrollable ancestor** (`scrollWidth > clientWidth` false
everywhere). The rail exists, receives layout, and cannot be reached or dismissed. Any
half-screen window on a 13" laptop (a completely normal way to use an all-day companion tool)
lands in this band. (Exact upper bound of the band should be confirmed in `AppShell.css`
before fixing, as inventory notes.)

### O4 · P1 — Raw workspace UUID as permanent end-user chrome, twice
`notes-1440.png` bottom-left: footer reads `workspace 089db7a6-6acb-` — truncated mid-UUID, so
it fails even as a copyable identifier. Inventory §"Sidebar contents": the workspace `<select>`
option text also embeds the UUID ("Shared workspace (opened via link) — 089db7a6-…"), which is
why the select's visible text clips ("Shared workspace (…") in every desktop screenshot.
End-user UI should never show a raw UUID as primary text: it is unreadable, undistinguishing
(all UUIDs look alike), and it spends the sidebar's last permanent row on a debugging artifact.
If a support identifier is needed, put it behind an "About/Copy workspace ID" action.

### O5 · P1 — Permanently-docked creation forms are the app's dominant IA pattern, and they misallocate space by frequency of use
Four instances, all always-visible, several with disabled buttons at rest:
- Sidebar: "New workspace title" input + disabled "+ New workspace" button (`notes-1440.png`) —
  creating a workspace is a once-a-quarter act at most; it holds ~110px of the most-seen
  pixels in the product, above the core nav.
- Chat rail: "New chat title" input + "New chat" button always docked above the thread
  (`chat-rail-1440.png`) — visible even mid-conversation.
- Backlinks: "New node title — links here as a backlink" + "Create + link" always under the
  note (`notes-1440.png`), even in the empty state (`notes-empty-1440.png`).
- Supertags: the create form **plus an eight-checkbox "Parents" picker** renders above the tag
  list at all times (`supertags-1440.png`), pushing the actual content (the tag list) below it.

The pattern inverts frequency-of-use: rare actions get permanent prime space; the content those
spaces exist for gets pushed down. Craft, Notion, Linear, and Bear all put creation behind a
`+` affordance or a keyboard command; none of them dock an empty form permanently. A disabled
button at rest is additionally a WCAG-adjacent noise element (low-contrast, non-interactive,
yet visually a control).

### O6 · P2 — Mobile floating "Menu" pill occludes content
`notes-390.png`: the "Menu" pill sits directly on top of the Backlinks line
("…te — 2026-08-22 mentions th…" is legible through/behind it). The floating pair reserves no
space, so any content in the bottom ~90px is occluded and the tap can hit pill-vs-link
ambiguously. Standard fix: bottom safe-area padding on the scroll container equal to pill
height, or a slim bottom bar.

### O7 · P2 — The two mobile drawers appear to stack rather than being mutually exclusive
`nav-drawer-390.png` — captured as "the nav drawer" — shows the **agent chat** drawer content
with **two** close (×) buttons visible, one per drawer, and sidebar content sliver behind.
Either both drawers were open simultaneously, or opening one over the other produced a stacked
state. Two stacked full-height drawers on a 390px phone is a dead-end state (close order
matters, background scroll ambiguous). Needs a repro pass; flagged because the capture itself
exhibits it.

### O8 · P2 — The rail's fixed sections outlive their usefulness
`chat-rail-1440.png`: with no model configured, the rail is 352px of permanently docked UI whose
one function cannot run — heading, creation form, thread, composer, and a "PENDING CHANGES"
section that exists only to say "Nothing pending — accepted or reverted changes disappear from
here." A section whose empty state must explain its own mechanics ("disappear from here") is a
section that should not render when empty. Same at first-run (`notes-empty-1440.png`): the rail
shows "No chats yet." + form + "Create a chat to get started." — three pieces of chrome saying
nothing, at 24.4% of the screen.

---

## DIRECTION-LEVEL doubts (defensible either way — David's call)

### D1 · P0-as-a-decision — The permanently docked chat rail does not earn 24.4% of every screen
Every 1440 screenshot: the rail is present, full width, on Notes, Supertags, Calendar, Apps,
Graph, Bookmarks, Meetings, Workouts, Sharing — including screens where its thread is empty and
the environment can't even reply (O8). Chat utility is bursty: intense for minutes, absent for
hours. Persistent screen allocation should track persistent utility.

What comparable products do: **Notion** invokes AI on demand (keyboard trigger / toggleable
panel) — zero cost when unused. **Linear** has no docked AI surface at all; agent work surfaces
inside issues and ⌘K. **Craft**'s assistant is contextual and dismissable. The products that DO
keep a docked chat (Cursor, GitHub Copilot in IDEs) make it **user-collapsible with a
remembered state and a hotkey** — the dock is a mode, not a constant.

Concrete alternative that keeps the feature fully reachable (a fixed product truth): rail
collapses to a slim edge affordance (or nothing) with a hotkey + sidebar entry; auto-expands
when the agent has something pending (the PENDING CHANGES section becomes its badge). Reclaimed
352px would let the note column breathe at 1440 instead of being capped at 744.

### D2 · P1 — Account/workspace admin chrome owns the top of the sidebar hierarchy
`notes-1440.png`: order is brand → WORKSPACE label → switcher → new-workspace form → email +
DEV badge + Sign out → **then** Today. "Today" — the product's center — starts ~330px down a
900px viewport: the top ~37% of the most-seen column is administrative chrome that a personal
single-user tool touches approximately never. Sign-out as an always-visible top-level button in
an all-day personal tool is chrome for an event that happens monthly.

Comparisons: **Linear** and **Notion** compress workspace + account into one compact row whose
popover holds switch/create/settings/sign-out. **Bear** and **iA Writer** show no account
chrome in the nav at all. The defensible-either-way part is whether a workspace switcher row
belongs at top (fine); a five-element admin block does not — fold it into one row + menu and
Today becomes the first thing the eye lands on.

### D3 · P1 — The MORE list (7 items) is three different kinds of thing wearing one uniform
`notes-1440.png` sidebar: Graph, Calendar, Bookmarks, Meetings, Workouts, Sharing, Apps — seven
undifferentiated text links. Auditing what each actually is:

- **Calendar** — its own subtitle (`calendar-1440.png`) says "Google Calendar events merged
  alongside your daily note". By its own copy it is part of Today, not a sibling section.
  Strongest candidate to merge into the Today view (events beside/above the note), which is
  exactly what Reflect and Tana do with calendar events in the daily note.
- **Meetings**, **Workouts** — these are content-type views, i.e. what the Supertag primitive
  exists to produce (a #Meeting view, a #Workout view). Hardcoding them as top-level routes
  competes with the product's own organizing idea: if Supertags are the primitive (product
  truth), typed views should be *generated from* supertags (pin a supertag to the sidebar),
  not enumerated by hand. Tana works this way (any supertag gives you its table/view); that is
  the coherent version of this product's own thesis.
- **Bookmarks** — the value is the capture form (`bookmarks-1440.png`: "QUICK CAPTURE"); capture
  wants a global command/omnibox, not a destination you navigate to first. The list itself is
  archive-tier.
- **Graph** — a lens over the same data; occasional. Fine in an overflow, doesn't earn a
  permanent row.
- **Sharing** — settings-tier admin, belongs with the workspace menu (D2).
- **Apps** — a launcher; earns presence only once apps exist (the current screen,
  `apps-1440.png`, is a seed button and explanatory prose).

So of seven, arguably **zero** earn permanent top-level rows in their current form: one merges
into Today, two should be supertag-generated, and four are command-palette/menu-tier. Related
gap: **no command palette was observed anywhere** in the evidence base — for a keyboard-heavy
personal tool this is the single mechanism (Linear ⌘K, Notion ⌘P) that lets the nav shrink to
Today + Supertags without losing reachability. Its absence is why everything currently needs a
sidebar row.

### D4 · P2 — The note as a bordered card vs full-bleed writing surface
`notes-1440.png`: the note sits in a 744px bordered, 16px-radius card with 48px internal
padding, floating on `--color-ground` with a visible seam on all sides. The frame costs 96px of
width (13% of the card) and reads as "a widget displaying a note" rather than "the room you
write in". **iA Writer** and **Bear** are full-bleed — the paper is the window — precisely
because chrome around prose adds a spectator's distance to a surface you're supposed to inhabit
all day. **Craft** uses a page metaphor but the page *is* the whole canvas, not a card among
panels. Defensible counterargument: the card visually separates the editor from the two rails.
But if D1/D2 shrink the rails, the separation job disappears, and the border earns nothing.
Lean: full-bleed (or borderless column) for the note; keep cards for genuinely card-shaped
things (bookmarks, apps).

### D5 · P1 — Backlinks beside the prose is the wrong position at any width
Even in a hypothetically wide container, giving backlinks a permanent 320px column *beside* the
prose subordinates writing to metadata (and at the widths this app can actually reach it
produces O1). Roam, Reflect, and Logseq settled on backlinks **below** the note — consulted
after reading/writing, not competing during. Obsidian offers a side panel, but as an opt-in
pane the user opens. Recommendation: backlinks below, always single-column; O1 and O2 are
deleted as a side effect, and the container query goes away entirely.

### D6 · P2 — The first-run screen is chrome-forward, not writing-forward
`notes-empty-1440.png`: three panels of structure; the note card is ~600px tall in a 900px
viewport with the lower third of main empty; the card's right half is occupied by
"Backlinks / No backlinks yet." + a create form (the two-column grid runs even when everything
is empty); the supertags strip explains itself; the rail says "No chats yet". The one thing the
screen never does is invite the user to write — there is no visible prompt/placeholder in the
editor area of the screenshot. For a daily-notes product the empty daily note IS the product's
front door; it should be a cursor and an invitation, with backlinks/supertags appearing once
they exist.

---

## TASTE (labeled as such)

### T1 — Sidebar nav typography is control-room loud
Nav links measure Space Grotesk 600 at 19.2px with 56px rows (inventory §Typography) — larger
and heavier than the note's own body text. Generous tap targets are good; body-size bold nav in
a 248px column reads as shouting for a surface you glance at. Linear's nav is ~13px. Pure taste
until user testing says otherwise.

### T2 — Twin visible scrollbar tracks flank the main column
`notes-1440.png`: styled scrollbar pills are visible at the sidebar's right edge and main's
right edge simultaneously, adding two vertical chrome lines around the content. Taste — except
that scrollbar width is also the trigger for O2, which is not.

### T3 — The symmetric surface-rail / ground / surface-rail composition reads as a tunnel
Both rails share `--color-surface` against the darker ground, framing the main column in a
symmetric vignette every hour of the day. Subjective; noted because it compounds D4's
"widget in a case" feeling.

---

## Priority summary

1. **O2 + O1 via D5** — move backlinks below the note, delete the container query: removes the
   nondeterministic flip and the 28ch prose in one change.
2. **D1 + O8** — make the chat rail collapsible (remembered, hotkeyed, auto-expand on pending
   changes); hide empty PENDING CHANGES.
3. **O3** — fix the 500–~852px clipped-rail band.
4. **D2 + O4 + O5(sidebar instance)** — collapse the admin block to one row + menu; UUID out of
   visible UI; new-workspace behind the menu.
5. **D3** — Calendar into Today; Meetings/Workouts as pinned supertag views; a command palette
   to absorb the rest.
6. **O5 (remaining instances), O6, O7, D4, D6** in the course of touching each surface.

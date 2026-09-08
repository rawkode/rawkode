# Athenaeum design-system inventory (measured 2026-08-22)

Shared evidence base for the adversarial design review. Everything below was **read from
`packages/web/src/design-system/*.css` or measured live in Chrome against the running app on
`:3000`** (dev sign-in as `design-review@rawkode.academy`, isolated browser context — David's own
session untouched). Nothing is remembered or assumed.

Measurement viewport: 1440x900 (desktop pass) and true 390x844 via device emulation (mobile pass).
Note: a plain window resize bottoms out at Chrome's ~500px minimum window width — the first mobile
pass was invalid and was re-captured under emulation. Anyone re-measuring should emulate, not resize.

## Screenshots in this directory

| File | What it shows |
|---|---|
| `notes-1440.png` / `notes-390.png` | Daily note with real content (heading, prose, list, #Person tag, @mention) — captured in the single-column state (backlinks below, wide prose) |
| `notes-backlinks-1440.png` | Same note after a backlink exists / on the two-column side of the container query: prose squeezed to 294px with Backlinks beside it |
| `notes-empty-1440.png` | Daily note, fresh workspace (empty state) |
| `notes-tag-picker-1440.png` | `#` supertag picker mid-open in the editor |
| `notes-mention-picker-1440.png` | `@` mention picker mid-open in the editor |
| `notes-field-popover-1440.png` | Supertag field popover open (role/email/company + add-field row) |
| `chat-rail-1440.png` | Chat rail with a chat created, a sent message, and the "No AI model configured" reply |
| `chat-rail-390.png` | Agent chat as mobile drawer (via "Open agent chat" button) |
| `nav-drawer-390.png` | Sidebar as mobile drawer (via "Open navigation" button) |
| `supertags-1440.png` / `supertags-390.png` | Supertags manager with the Person tag defined |
| `supertags-empty-1440.png` | Supertags route, empty state |
| `bookmarks-1440.png` / `bookmarks-390.png` | Bookmarks with one saved bookmark |
| `bookmarks-empty-1440.png` | Bookmarks route, empty state |
| `graph-1440.png` / `graph-390.png` | Graph route |
| `calendar-1440.png` / `calendar-390.png` | Calendar route |
| `meetings-1440.png` / `meetings-390.png` | Meetings route |
| `workouts-1440.png` / `workouts-390.png` | Workouts route |
| `sharing-1440.png` / `sharing-390.png` | Sharing route |
| `apps-1440.png` / `apps-390.png` | Apps route |

## Color tokens (`src/design-system/tokens.css`)

Single-theme by design: dark-only, no light palette exists. OKLCH throughout; hue anchors
`--hue-neutral: 220` (cool tint for grays), `--hue-warm: 75` (warm tint for text),
`--hue-accent: 200` (cyan-teal). sRGB values below converted in-browser via canvas.

| Token | Declared value | ~sRGB |
|---|---|---|
| `--color-ground` | `oklch(16% 0.02 220)` | `#040f13` |
| `--color-surface` | `oklch(20% 0.021 220)` | `#0b181d` |
| `--color-surface-raised` | `oklch(24.5% 0.022 220)` | `#142328` |
| `--color-surface-sunken` | `oklch(13.5% 0.018 220)` | `#020a0d` |
| `--color-border` | `oklch(32% 0.024 220)` | `#25363b` |
| `--color-border-strong` | `oklch(54% 0.026 220)` | `#5e7379` |
| `--color-text` | `oklch(93% 0.02 75)` | `#f0e6da` |
| `--color-text-muted` | `oklch(72% 0.018 75)` | `#aba398` |
| `--color-text-faint` | `oklch(60% 0.014 75)` | `#857f77` |
| `--color-accent` | `oklch(74% 0.135 200)` | `#00c3cc` |
| `--color-accent-strong` | `oklch(82% 0.15 200)` | `#00e0ea` |
| `--color-accent-muted` | `oklch(28% 0.05 200)` | `#003033` |
| `--color-accent-tint` | `oklch(21% 0.03 200)` | `#051c1e` |
| `--color-on-accent` | `oklch(15% 0.03 200)` | `#000f10` |
| `--color-danger` | `oklch(68% 0.19 27)` | `#f75e54` |
| `--color-danger-muted` | `oklch(26% 0.06 27)` | `#3c1714` |
| `--color-danger-border` | `oklch(45% 0.1 27)` | `#843c36` |
| `--color-danger-text-strong` | `oklch(78% 0.13 27)` | `#ff958a` |
| `--color-success` | `oklch(76% 0.15 152)` | `#5bcc80` |
| `--color-success-muted` | `oklch(24% 0.05 152)` | `#092613` |
| `--color-warning` | `oklch(80% 0.14 85)` | `#e7b643` |
| `--color-warning-muted` | `oklch(27% 0.05 85)` | `#322405` |
| `--color-warning-border` | `oklch(45% 0.1 85)` | `#6e5000` |

Token comments in the file record two prior contrast fixes: `--color-border-strong` raised
42%→54% L (to pass WCAG 1.4.11 3:1 non-text) and `--color-text-faint` raised 52%→60% L
(to pass 4.5:1 AA against `--color-surface`).

## Typography (`fonts.css` + tokens + live measurement)

Three self-hosted OFL variable fonts (no CDN):

- `--font-display`: **Fraunces Variable** (opsz 9-144, wght 300-900) — headings.
- `--font-data`: **Space Grotesk Variable** (wght 300-700) — body/UI default, nav, labels, ids.
- `--font-prose`: **Source Serif Variable** (wght 300-600) — daily-note prose only.

Fluid type scale (clamp), resolved at 1440px viewport:

| Token | Declared | At 1440px |
|---|---|---|
| `--text-xs` | `clamp(0.72rem, 0.69rem + 0.14vw, 0.8rem)` | 12.8px |
| `--text-sm` | `clamp(0.82rem, 0.79rem + 0.16vw, 0.92rem)` | 14.72px |
| `--text-base` | `clamp(0.94rem, 0.9rem + 0.2vw, 1.02rem)` | 16.32px |
| `--text-md` | `clamp(1.05rem, 0.99rem + 0.3vw, 1.2rem)` | 19.2px |
| `--text-lg` | `clamp(1.24rem, 1.12rem + 0.55vw, 1.55rem)` | 24.8px |
| `--text-xl` | `clamp(1.55rem, 1.32rem + 1.05vw, 2.15rem)` | 34.4px |
| `--text-2xl` | `clamp(2.05rem, 1.6rem + 2vw, 3.1rem)` | 49.6px |

Live-measured on `/notes` at 1440:

- `body`: Space Grotesk, 16.32px, on `--color-ground`.
- `main h1` ("Today's daily note"): Fraunces, 49.6px / 57px, weight 500, `--color-text`.
- Prose paragraph: Source Serif, **19.2px / 33.6px** line-height, `--color-text`.
- Sidebar nav link: Space Grotesk **600 19.2px/28.8px**, row height 56px.

## Spacing / radii / motion

- Spacing scale: `--space-1..8` = 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 3 / 4.5 rem.
- Radii: `--radius-sm: 5px`, `--radius-md: 9px`, `--radius-lg: 16px`.
- Shadow: single `--shadow-raised` (two dark layers).
- Motion: one easing (`cubic-bezier(0.25, 1, 0.5, 1)`), durations 120/200/280ms; transform/opacity only; global `prefers-reduced-motion` kill switch in `base.css`.

## Shell layout — the three columns (measured at 1440x900, `/notes`)

| Column | Element | Width | x |
|---|---|---|---|
| Left sidebar | `[aria-label="Workspace"]` | **248px** (`--shell-sidebar-w: 15.5rem`) | 0 |
| Main | `main.shell-main` | **840px** (pad 32px 48px) | 248 |
| Chat rail | `[aria-label="Agent chat"]` | **352px** (`--shell-chat-w: 22rem`) | 1088 |

Sidebar and chat rail backgrounds are both `--color-surface`; main is transparent over
`--color-ground`.

Inside main on `/notes`: `.route-view` max-width 896px → 744px actual; `section.daily-note`
has 48px padding (`--space-7`) and, per `app.css`, is a container-queried grid:

```css
.notes-route { container-type: inline-size; container-name: notes; }
.daily-note { display: grid; grid-template-columns: minmax(0, 1fr); }
@container notes (min-width: 46rem) {
  .daily-note { grid-template-columns: minmax(0, 1fr) 20rem; } /* backlinks beside prose */
}
```

### Measured prose column: 294px at 1440 (two-column state), ~28 chars/line

In the two-column state the grid resolves to **`294px 320px` + 32px gap** (measured), i.e. the
prose editor gets **294px**, which at 19.2px Source Serif is **~28 characters per line**
(measured via average glyph width of a mixed-case sample; common readability target is 45-75).
The 320px backlinks column is wider than the prose it sits beside.

**Razor-edge breakpoint:** the container is 744px and the query threshold is 46rem = 736px —
an 8px margin. During capture the same 1440px window rendered BOTH states at different moments
(`notes-1440.png` = single column, wide prose; `notes-backlinks-1440.png` = two columns, 294px
prose) — anything that shaves ≥9px (e.g. a scrollbar) flips the entire daily-note layout.

## Sidebar contents (top to bottom, from a11y tree)

1. Brand wordmark "Athenaeum".
2. `WORKSPACE` label + workspace `<select>` (option text includes the raw workspace UUID, e.g.
   "Shared workspace (opened via link) — 089db7a6-…").
3. "New workspace title" input + disabled "+ New workspace" button (always visible).
4. Account line: email + `DEV` badge + "Sign out" button.
5. Nav "Core": **Today**, **Supertags**.
6. `MORE` label; nav "More sections": **Graph, Calendar, Bookmarks, Meetings, Workouts, Sharing, Apps**.
7. Footer: "workspace" + full raw UUID.

## Chat rail contents (permanently docked at desktop)

Heading `AGENT CHAT`; chat list (or "No chats yet."); "New chat title" input + "New chat" button;
message thread ("YOU" label per user message); "Message the agent" input + Send;
`PENDING CHANGES` section ("Nothing pending — accepted or reverted changes disappear from here.").
In this dev environment the agent reply is the inline warning "No AI model configured." with
`wrangler secret put ANTHROPIC_API_KEY` remediation copy (see `chat-rail-1440.png`).

## Responsive behavior (measured)

- At a true 390px viewport the shell collapses to a single column with two floating toggle
  buttons: **"Open navigation"** and **"Open agent chat"**, each opening a drawer
  (`nav-drawer-390.png`, `chat-rail-390.png`).
- At the 500px un-emulated minimum window width, the chat rail rendered off-viewport
  (rect x=500, w=352 with `window.innerWidth`=500) with **no horizontally scrollable container**
  (checked `scrollWidth > clientWidth` on html/body/all divs) — i.e. between the mobile breakpoint
  and ~852px the rail can be clipped and unreachable. Reviewers should verify the exact
  breakpoint in `AppShell.css` before citing this.

## Route inventory (what each renders)

- `/notes` — "Today's daily note": DAILY NOTE eyebrow, weekday h2 + ISO date, ProseMirror rich
  editor (drag-handle `⠿` per block), Synced indicator, "Supertags on this note" region,
  Backlinks section with "New node title" + "Create + link" form.
- `/supertags` — Supertags manager (tag list + field schema editing; field types: text, number,
  date, checkbox, entity-ref).
- `/graph` — graph view of nodes/edges.
- `/calendar` — calendar day view + Google Calendar OAuth connect.
- `/bookmarks` — "QUICK CAPTURE / Bookmarks": URL + optional title form, list below.
- `/meetings` — meetings panel.
- `/workouts` — workouts panel.
- `/sharing` — share management.
- `/apps` — app launcher grid / library.
- Signed-out (any route) — centered dev sign-in card: "Dev sign-in — a stand-in for real
  sign-in… Any email works" + Email field + "Sign in (dev)".

## Microcopy verbatim (empty states seen)

- Daily note supertags: "No Supertags yet — type # in the note to apply one."
- Backlinks: "No backlinks yet."
- Chat: "No chats yet." / "Create a chat to get started."
- Bookmarks: "Paste a URL to save it to this workspace — a lightweight capture list, not a full
  reading app." / "No bookmarks yet — paste a URL above."
- Pending changes: "Nothing pending — accepted or reverted changes disappear from here."

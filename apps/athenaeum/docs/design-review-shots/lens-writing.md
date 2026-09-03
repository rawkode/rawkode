# Lens 1 — Writing-tool first principles

Adversarial pass on the daily note as a WRITING surface, judged against iA Writer, Bear, Ulysses,
Craft. Evidence: the screenshots in this directory (cited per finding) plus the measured values in
`inventory.md`. Classes: **OBJECTIVE** (measurable defect), **DIRECTION** (defensible either way —
David's call), **TASTE** (labeled as such). Severity: High / Medium / Low.

## Verdict in one paragraph

The prose itself is good — Source Serif at 19.2px/33.6px on a ~65ch measure (single-column state,
`notes-1440.png`) is genuinely pleasant, better than most notes apps ship. Everything AROUND the
prose fights it. The daily note is rendered as a widget in an ops dashboard: a bordered card between
two permanent rails, topped by ~285px of ceremony, flanked by a backlinks pane that can steal the
line length down to a measured 28 characters, inside a dark-only theme at ~15:1 text contrast with
no light mode in existence. The stated center of the product is hours of daily writing; the chosen
direction serves monitoring, not composition. Recommendation committed to at the end: treat the
daily note as a page, not a panel.

---

## W1 — OBJECTIVE / High: the two-column state gives prose 294px (~28ch) and gives Backlinks more width than the writing

Measured (`inventory.md`): in the container-query two-column state the grid resolves to
**294px prose + 320px backlinks + 32px gap**. At 19.2px Source Serif that is **~28 characters per
line** — far below the 45–75ch readability range. `notes-backlinks-1440.png` shows the result: the
paragraph "Spent the first hour with the / Athenaeum design review before / the platform sync…"
wraps every four or five words; the three-item list wraps every bullet onto two lines; the sentence
containing the Person pill and the mention link shatters across three lines. Meanwhile the
**backlinks column is 26px wider than the prose it decorates**, to display one line of text and an
empty form. No writing tool on the market puts the note's own body in the narrow column. Bear and
Reflect put backlinks in a collapsed strip at the note's end; iA Writer doesn't have them; Craft
puts them below the page. At 1440px, a 744px container should never split — the two-column layout
only begins to make sense at widths that don't exist inside an 840px main column.

**Fix:** never let the prose measure drop below ~50ch; backlinks go below the note (or behind a
disclosure), not beside it. Delete the `46rem` two-column branch or raise it beyond the container's
possible width.

## W2 — OBJECTIVE / High: the entire note layout flips on an 8px razor edge

Measured (`inventory.md`): container 744px, query threshold 46rem = 736px. The same 1440px window
produced both layouts during capture (`notes-1440.png` single-column vs `notes-backlinks-1440.png`
two-column) — anything that shaves ≥9px, e.g. a scrollbar appearing as the note grows, flips the
page between ~65ch and ~28ch prose. Concretely: **writing enough to make the page scroll can
collapse your own line length by half, mid-session**. For an all-day writing surface, layout
stability under one's own typing is table stakes; iA Writer's measure never changes while you type.
This alone would justify reopening the layout even if W1's narrow column were acceptable.

## W3 — OBJECTIVE / Medium: the empty daily note never invites you to write

`notes-empty-1440.png`: fresh workspace, today's note. Between the date and "Synced" there is
**no placeholder, no caret affordance, no "start writing" invitation — nothing**. The only visible
interactive elements on the writing page are the Backlinks form ("New node title — links here as a
backlink" + "Create + link") and, in the rails, workspace/chat administration. The one hint about
the editor is phrased as feature documentation ("No Supertags yet — type # in the note to apply
one") and sits *below* the invisible editor it refers to. Compare: an empty iA Writer or Bear note
is a blinking caret on an empty page — the affordance IS the emptiness, but only because nothing
else competes. Here everything else competes and the editor itself is the one element with zero
visual presence. First keystroke of the day should have an obvious home: a placeholder line in the
prose font ("What's happening today?") and focus in the editor on load.

## W4 — OBJECTIVE / Medium: mobile floating pills occlude the note; the brightest element on the writing screen is the chat button

`notes-390.png`: the floating "Menu" pill and the filled-cyan "Agent" pill sit ON TOP of note
content — the backlinks line renders as "te — 2026-08-22 mentions th…" with both ends hidden under
the pills. The Agent pill in solid `--color-accent` cyan is the single highest-salience object on a
page whose job is reading and writing one's own words. Mobile prose measure itself is fine (~32ch
at 390px is normal for phones), but overlay chrome must reserve scroll padding, and the resting
state of a chat affordance on a writing surface should be quiet (compare Bear/Craft on iOS: toolbar
chrome fades while writing).

## W5 — DIRECTION / Medium (measured basis): ~15:1 prose contrast on a dark ground is a halation risk for hours of reading one's own text

Measured: `--color-text` #f0e6da on the card surface #0b181d computes to **~15:1** (and ~15.8:1 on
the ground). WCAG sets no upper bound, so this is not a compliance defect — but for sustained
light-on-dark reading, very high contrast produces halation (glow/fringing around thin serif
strokes, worst for astigmatic readers, which is a large minority of users). It is telling that the
tools built for long-form dark-mode writing do not ship near-white-on-near-black serif body text;
their dark themes sit the body text noticeably below maximum contrast. The token file already
records two contrast fixes *upward* for AA minimums (`inventory.md`) — the body text needs the
opposite adjustment. If dark stays, drop prose (not UI) text to roughly 10–12:1 and consider a
slightly lifted surface behind long-form text.

## W6 — DIRECTION / High: dark-only is the wrong default for the product's own stated center — and there is no light mode at all

Fact (`inventory.md`): "Single-theme by design: dark-only, no light palette exists." The app
ignores `prefers-color-scheme` because there is nothing to switch to.

**Case for the dark command-center:** it flatters the ops-adjacent parts of the app (graph, chat,
calendar); it photographs well; David plausibly lives in dark terminals all day and a personal tool
may follow personal preference; evening use is genuinely better dark.

**Case against:** the product's declared center is prose composition for hours, much of it in
daylight. Every tool whose center is writing — iA Writer, Ulysses, Bear, Craft — defaults to a
paper-light canvas and offers dark as a *mode*, usually following the OS. That is not fashion
conservatism; light backgrounds win for sustained prose in lit rooms (no halation, better
perceived sharpness of serif text, and the psychological register of "page" rather than
"terminal"). The current direction makes the writing surface borrow the aesthetics of the app's
periphery. A command-center look for the *rails* does not require a command-center look for the
*page*.

**Committed recommendation:** build the light palette and make theme follow the OS, with the
current dark kept as the night mode. If David personally wants dark-default, fine — it's his tool —
but "dark-only, no light mode exists" is indefensible for an all-day writing product even as a
personal one; at minimum W5's contrast reduction and W7's de-chroming are needed to make dark
livable for prose.

## W7 — DIRECTION / High: the note is dressed as a dashboard widget; iA Writer would delete almost everything on this screen

`notes-1440.png`, counted from the pixel evidence, the writing surface carries: a bordered,
raised card around the note; a `DAILY NOTE` eyebrow; a 49.6px Fraunces weekday; an ISO date; a
per-block drag handle (`⠿`); a permanent green "Synced" indicator; a dashed separator; a tag row;
a "Backlinks" heading with an always-visible node-creation form; a 248px sidebar whose top half is
workspace *administration* (workspace select with raw UUID in the option text, an always-visible
"New workspace title" input + disabled button, account line, DEV badge, sign-out, and a footer
printing the full workspace UUID); and a permanently docked 352px chat rail. The editor's actual
writing width is ~648px of a 1440px viewport — **45% of the screen is for writing; 55% is chrome**.

What iA Writer would delete: the card border (page fills the canvas), the eyebrow (the date says
it), the sync indicator (show only on failure — silence is the success state), the always-visible
backlink form (creation is a command, not furniture), the workspace admin block (behind a switcher
menu), the docked chat (summonable). What Bear/Craft would keep: one quiet collapsible sidebar,
note fills the rest. None of these tools show ANY persistent status or forms inside the writing
canvas.

**Fix:** while the caret is in the note, chrome recedes: sidebar collapsible (⌘\-style), chat rail
summonable (W8), backlinks below the fold behind a count ("2 backlinks"), sync silent unless
failing, card border dropped so the note reads as the page itself.

## W8 — DIRECTION / Medium: a permanently docked chat rail is resident overhead on the writing home

`notes-1440.png` / `chat-rail-1440.png`: at rest the rail is 352px (24% of viewport) of mostly
empty surface whose permanent contents are administrative: an `AGENT CHAT` label, "No chats yet.",
a "New chat title" input, a "New chat" button, and a `PENDING CHANGES` section whose empty state
explains its own mechanics ("Nothing pending — accepted or reverted changes disappear from here.").
The agent is a strong feature — but chat-as-furniture taxes every writing hour for a capability
used in bursts. Notion's AI and Craft's assistant are *summoned* (shortcut/button) and dismissed;
they don't hold a permanent fifth of the canvas. Keep the rail as the docked state for a chat in
active use; the default on the writing home should be closed with a modest affordance, and
`PENDING CHANGES` should appear only when something is pending.

## W9 — DIRECTION / Medium: ~285px of ceremony before the first written word, and the biggest type on screen is chrome

`notes-1440.png`: eyebrow at y≈125 → first prose line at y≈410 — roughly **285px of a 900px
viewport (a third of the screen) spent on DAILY NOTE / Saturday / 2026-08-22**, three renderings of
the same fact, which the sidebar also states as "Today". The 49.6px Fraunces "Saturday" is the
largest element in the app and it is metadata. It is handsome (see W11 — keeping Fraunces somewhere
is defensible taste) but it pushes the actual writing below the midline of the screen every single
day. Bear renders the note title as the first *editable* line; iA renders nothing above your text.
Fold the identity into one modest line ("Saturday · 22 Aug") and give the reclaimed 200px to prose.

## W10 — DIRECTION / Medium: backlinks are presented as co-equal writing-time content, with a creation form as permanent furniture

`notes-1440.png` / `notes-empty-1440.png`: the Backlinks section ships a full-width "New node
title — links here as a backlink" input + "Create + link" button, always visible, even on an empty
note — where it is the page's most prominent interactive element (W3). Backlinks are read-mostly,
occasionally-used material; tools that have them (Bear, Reflect, Craft) show them as a quiet
collapsed list at the end of the note, and node creation happens through `@`/`[[` in the text —
which Athenaeum *already supports* (`notes-mention-picker-1440.png` shows the @ picker working
inline). The form duplicates an inline capability at permanent screen cost. Move creation into the
picker's "create new" row; render backlinks as a collapsed count.

## W11 — TASTE / Low: the three-typeface system puts three voices on one card

`notes-1440.png`: one screen shows Fraunces (wordmark, weekday, "Backlinks"), Space Grotesk
(eyebrow, date, nav, tags, Synced, every input), and Source Serif (prose). Each is a good face;
together the note card alone speaks in three voices, and Space Grotesk's geometric/techno register
sits oddly against a literary serif — it is the main carrier of the "command-center" flavor the
writing surface doesn't want. iA Writer uses one family; Bear effectively one per note. A two-font
system (Fraunces display + Source Serif prose, with UI in a neutral) would calm the page. This is
labeled taste: the trio is internally consistent and competently applied; it's a mood choice, and
the mood chosen is the reviewed direction's hypothesis.

## W12 — DIRECTION / Low (with one OBJECTIVE inconsistency): inline supertag/mention rendering makes metadata the loudest thing in the paragraph

`notes-1440.png`: mid-sentence, the filled teal "Person" pill and the bright-teal mention link
"Daily Note — 2026-08-22" (which wraps across two lines) are the highest-salience objects in the
prose — brighter than the words. In a writing tool the author's words should win; links/tags can be
half a step quieter (Bear's inline tags are muted until hovered). OBJECTIVE sub-point: the inline
pill renders as "Person" while the tag row below renders "#Person" (`notes-tag-picker-1440.png`
shows the picker also using "#Person") — same object, two spellings on one screen. Pick one.

## What is RIGHT (kept honest)

- **The measure in the single-column state is correct:** ~65ch at 19.2px/33.6px
  (`notes-1440.png`, measured in `inventory.md`) — inside the 45–75ch sweet spot, with generous
  1.75 leading appropriate for a dark theme. This is the state to protect (W1/W2).
- **Source Serif as the prose face is a good call** — a real text serif, not a display face, and
  the screenshots show clean rendering at this size. The editor surface itself (caret after
  "08-22" in `notes-1440.png`, unobtrusive per-block handles) looks calm; caret/selection behavior
  can't be judged from stills and is flagged for live verification, not asserted.
- **Motion restraint** (one easing, ≤280ms, transform/opacity only, global reduced-motion kill
  switch) is exactly right for a writing tool.
- **The pickers are good writing UX:** `#` and `@` popovers appear at the caret, small and
  legible (`notes-tag-picker-1440.png`, `notes-mention-picker-1440.png`) — the inline-command model
  is the right one, which is precisely why the permanent forms (W10) are unnecessary.
- The empty-state microcopy that exists is human and short; the failure-state copy in
  `chat-rail-1440.png` ("No AI model configured… wrangler secret put ANTHROPIC_API_KEY") is
  developer-honest and actionable.

## Committed recommendation

**The daily note is a page, not a panel.** Concretely, in priority order: (1) fix W1/W2 so the
measure is stable and never under ~50ch; (2) build the light theme, default to OS preference, and
soften dark prose contrast to ~10–12:1 (W5/W6); (3) let chrome recede while writing — chat
summonable, sidebar collapsible, backlinks collapsed below, sync silent, card border gone, header
ceremony to one line (W7–W10); (4) quiet the inline metadata (W12). The command-center aesthetic
can survive in the rails and the ops routes; the page the product is named for should feel like
paper — or at night, like ink.

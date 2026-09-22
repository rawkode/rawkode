# Apsides for Apple

Status: product contract and release plan, not evidence of shipped capabilities.

## The job

Keep the thought, prepare for the next commitment, and return to useful context.
Apsides should earn its place on each device by doing that job in the physical
setting where the device is used. A universal product shares identity and data;
it does not repeat the desktop interface on every screen.

The first useful slice is a private, durable notebook that works without signing
in. Capture must survive closing the app and being offline. The complete first
release additionally requires verified account sync, document compatibility, and
connected context. A locally saved note is not a synced note.

## Purpose by device

| Surface | Physical setting and primary job                                    | Purpose-built interaction                                                                                        | Deliberately absent                                                    |
| ------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Mac     | At a desk, turning thoughts into sustained work                     | Continuous document, keyboard commands, Today and Supertags navigation, context beside writing when width allows | Dashboard of duplicated summaries                                      |
| iPhone  | Between commitments, catching a thought or finding the next meeting | Open into Today; prominent quick capture; full-screen writing; push into calendar, person, or repository detail  | Permanent desktop sidebar                                              |
| iPad    | Reading, planning, and writing with touch or keyboard               | Adaptive split navigation and document/context; keyboard support; collapse cleanly in narrow multitasking        | A stretched phone list or mandatory three columns                      |
| Watch   | Hands briefly free, phone inconvenient                              | One capture action, recent saved confirmation, next event glance, short recent captures                          | Rich-text editing, repository feeds, entity administration             |
| CarPlay | Driving, attention belongs on the road                              | Next-event glance through an eligible widget; separately gated voice interaction                                 | Document editing, scrolling timelines, Supertag management, dense text |

## First-release journeys

### Capture and return

1. First launch opens an empty Today document with a clear place to write.
2. The user writes without choosing a project, tag, or account first.
3. A save indicator changes only after persistence succeeds. Failed saves retain
   the draft and expose retry or recovery without claiming success.
4. Relaunch returns the saved text. Choosing another day never loses pending
   input. A quick capture records its creation time and an immutable ID.
5. Captures can be reviewed and incorporated into the day document deliberately;
   background import must not rewrite the paragraph currently being edited.

Device transfer is a separate status: Watch can say “Saved on Watch” before the
phone receives it. The phone and account acknowledge receipt independently.
Retries use the original capture ID so reconnecting does not duplicate content.

### Write with meaning

Mac, iPhone, and iPad retain the writing-first model. Selected text followed by
`#` opens Supertags directly and preserves its words. `@` searches entities
across types, with clear empty/loading/error states and enough results to find a
match. The editor must preserve the existing authoritative document
representation; unsupported rich content cannot silently become plain text when
saved.

The first offline implementation may expose plain capture and local tags as a
limited slice. It must label that boundary and must not claim complete web
Supertag/entity parity until the canonical IDs and document round trips pass QA.

### Find relevant context

Today offers compact previews, at most three entries per context type. View all
opens a surface fitted to the content:

- Events: calendar day, all-day events, overlaps, local timezone, event notes.
- People: searchable directory and individual entity detail.
- GitHub: repositories ordered by latest activity; a repository opens a newest
  first timeline with activity-type filtering. Call this activity, not unread
  notifications unless the data contract actually supplies notification state.

Use the user's own connected data only after authentication. An offline empty
calendar is distinguishable from a disconnected service or failed refresh.
Cached context displays freshness when it could affect the next action.

## Visual and interaction contract

### Modern Apple baseline

Minimum deployment targets are iOS 26, iPadOS 26, macOS 26, and watchOS 26. Use
native Liquid Glass navigation and controls. Earlier OS fallback designs are
outside this product's scope. Evaluate OS 27-specific APIs separately; do not
raise the minimum just because a newer SDK is installed.

Native toolbars, tab bars, sidebars, search, and presentations form the
functional layer. Rosé Pine belongs in the content beneath it. Remove opaque
navigation fills that obscure system materials. Notes, calendar events, and
timeline rows remain content, not glass surfaces. Prefer native components to
custom glass. See
[Apple's material hierarchy](https://developer.apple.com/design/human-interface-guidelines/materials).

### Design quality acceptance

Apple Design Award quality is the ambition, not an achieved certification or a
claim about this build. Assess these observable outcomes:

- The primary task and current location are immediately clear. Titles and
  metadata do not repeat or compete with writing.
- Direct manipulation has an understandable result. Choosing a date changes the
  document; moving a capture into Today reveals its destination and offers
  appropriate recovery. Preserve focus and selection when navigating.
- Feedback follows durable state. Brief confirmation and supported haptics
  happen after save succeeds. Failure remains visible. Motion explains change
  and has a reduced-motion equivalent; it does not decorate every row.
- Dynamic Type, VoiceOver, keyboard, pointer, reduced transparency, and
  increased contrast receive equivalent task access. Fixed sheets and tiny Watch
  captions must not hide primary actions or the meaning of state.
- Device purpose remains clear: sustained writing on Mac, quick capture on
  phone, flexible composition on iPad, brief capture and timely context on
  Watch, and glanceable information in the car.
- Identity comes from typography, useful content, spacing, and Rosé Pine
  surfaces. Native glass alone does not establish character or product
  completeness.

Record observed failures and close them with interaction tests. Screenshots do
not replace persistence, focus, accessibility, or device validation.

Use the established Rosé Pine Dawn and Dark palette from
`website/src/styles/workspace.css`: Dawn base `#faf4ed`, surface `#fffaf3`, ink
`#575279`, action `#286983`; Dark base `#191724`, surface `#1f1d2e`, ink
`#e0def4`, action `#9ccfd8`. Save the explicit choice. Platform-hosted widgets
and CarPlay templates may adapt appearance for legibility and system
presentation.

Use native controls, system typography for controls, and a restrained serif only
where it improves document reading. Reserve accent for action, selection, and
meaningful state. No decorative cards, side stripes, or redundant headings.
Every visible item must enable an action, identify location, show relevant
content, or explain state. Remove items that do none of these.

Respect Dynamic Type, VoiceOver, keyboard focus, reduced motion, and contrast.
Save/error feedback must not rely on color. Avoid permanent technical status
panels; expose recovery detail when it helps resolve a problem.

## CarPlay boundary, researched 2026-09-12

Apple's current overview includes voice-based conversational apps among
supported categories. It also says small widgets and Live Activities can appear
in CarPlay. A next-event widget is therefore the first candidate for useful
in-car context. This is a product inference, not confirmation that any specific
Apsides build is eligible or renders correctly.
[Apple CarPlay overview](https://developer.apple.com/carplay/)

A full CarPlay app requires the appropriate category entitlement. Apple reviews
the request, grants managed capability access, and requires matching App ID,
profile, and target entitlements. Having a template implementation does not
grant permission or prove App Store acceptance.
[Requesting CarPlay entitlements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)

Do not classify a notebook as a driving-task app simply to obtain a capability.
Before implementing a full voice app, confirm that the actual proposed
experience fits Apple's current conversational category and template rules. Do
not invent an entitlement string from category names. The legacy entitlement
article's table does not enumerate every category in the current overview;
consult the current guide and developer account when applying.

Pending validation, scope CarPlay to a glanceable next-event widget, with
privacy redaction and stale-data handling. A later voice capture flow needs
explicit listening state, cancellation, audible save/failure feedback,
interruption recovery, and no textual editor. Do not portray a phone App Intent
as a tested CarPlay app.

## Delivery sequence and ownership

| Stage               | Value delivered                                                             | Exit evidence                                                                                    |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Local foundation    | Durable Today writing and capture on independently designed Apple surfaces  | Core tests, target builds, actual save/relaunch walkthroughs                                     |
| Device continuity   | Watch capture arrives exactly once on phone; local work survives outages    | Paired-device disconnect/reconnect and retry evidence                                            |
| Connected workspace | Own account, canonical documents/entities, real calendar and GitHub context | Auth isolation, compatibility and sync conflict tests, live workflow                             |
| Apple surfaces      | Useful widgets/Shortcuts; eligible CarPlay functionality                    | Widget and intent runtime tests, platform permissions and entitlement evidence                   |
| Distribution        | Installable supported releases                                              | Signed archives, privacy/account review, accessibility and device QA, TestFlight/App Store gates |

Engineering owns persistence, identity, compatibility, and platform adapters.
Design owns device journeys and content density. QA owns evidence and regression
coverage; product owns scope and acceptance. One integration owner reconciles
these gates and records the exact remaining gaps at each handoff.

Success means a user can capture offline, recover the exact thought, and trust
its save status. Measure capture-to-durable-save latency and duplicate/lost
capture counts in controlled QA without collecting note contents. Set release
performance budgets from device measurements, not invented benchmark claims.

## Explicit first-release limits

No automatic rewrite of authored notes, no unverified cross-device sync claims,
no fake connected data presented as the user's data, and no
complete-universal-app claim based only on Swift compilation. The implementation
may advance stages independently, but each surface's shipped and unverified
states remain explicit.

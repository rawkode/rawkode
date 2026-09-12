# Enchiridion: earning a place as the daily planner

Assessment: 12 September 2026, source review at `5fad3fac` plus the working
tree. This is a product recommendation, not a shipping or device-qualification
claim. No application code was changed for this assessment.

Enchiridion's opportunity is the connection between commitments, the work around
them, and what the user decides to do next. Open the day, understand the next
meeting, capture its outcome, and turn a sentence into a follow-up without
copying between apps. Replacing an established planner requires reliable
commitments before additional visual surfaces.

## What exists

| Area             | Evidence in this checkout                                                                                                                                                                                      | Replacement gap                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar context | Google calendar ingestion, series and exceptions, day queries; native agenda and cached next-event snapshot. `integrations/google/src/sync.ts`, `account-api.ts`, `apple/Sources/Core/ConnectedContext.swift`. | OAuth calendar scopes are read-only. No verified event creation, rescheduling, invitation management, or booking service. Native event model loses some provider detail.         |
| Notes and graph  | Tiptap task checkboxes, daily/event/series documents, entities, extensible Supertags, provider observations and links. `website/src/editor/extensions.ts`, `eventDocuments.ts`, `core/entities/schema.ts`.     | A checkbox or `base:task` entity is not yet a complete task lifecycle with recurrence, reminders and cross-device completion.                                                    |
| Capture          | Durable local capture ledger, Watch transfer, explicit server send and receipt distinctions, Shortcuts capture. `WorkspaceStore.swift`, `CaptureSpool.swift`, `WatchBridge.swift`.                             | Local daybook and remote rich notebook are separate; capture-to-daybook must not imply server synchronization. Incoming rich captures can be unsupported.                        |
| Persistence      | Web document writes serialize saves and detect conflicts; local native vault stores drafts/captures. `website/src/editor/documents.ts`, `VaultPersistence.swift`.                                              | No verified durable offline outbox for the remote rich editor. Remote calendar cache is hidden until account verification on launch. These are not an offline planner guarantee. |
| Context          | Connected people and GitHub activity, repository timelines and filters, event-linked notes.                                                                                                                    | Activity is evidence of work, not automatically a task, appointment, or priority. Don't fill a calendar with every notification.                                                 |
| New home         | Working-tree `PhoneTodayView.swift` provides two note-entry styles and delegates to a day timeline.                                                                                                            | Treat as the active release candidate; this review did not run it or establish what is installed.                                                                                |

No production account, TestFlight installation, notification delivery or
cross-device workflow was tested here. Demo fixtures are not evidence that a
user's connected calendar works.

## Current product baseline

Fantastical combines calendar/task views, event editing and scheduling. Its
Openings feature offers shareable availability from selected calendars, booking
templates, buffers, lead time, time zones and automatic or manual approval. That
makes a dependable booking link an important part of replacing it for this user.
[Fantastical](https://flexibits.com/fantastical),
[Openings documentation](https://flexibits.com/fantastical-ios/help/openings).

Todoist's baseline includes recurring tasks with explicit scheduled-date versus
completion-date semantics, reminders, and calendar integration. A visually
attractive list without those behaviors cannot replace its commitment tracking.
[Recurring dates](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV),
[Reminders](https://www.todoist.com/help/todoist/features/introduction-to-reminders-9PezfU),
[Calendar integration](https://www.todoist.com/help/todoist/integrations/use-the-calendar-integration-rCqwLCt3G).

## Three investments, in order

### 1. A trustworthy day and a dependable note

Finish the already requested release: open around now, center the ongoing or
next event, show quiet graph markers with accessible labels, and offer the two
settings-selectable note controls. Keep all-day events and empty days
meaningful. Show stale/partial context honestly. Selection-based Supertagging
must preserve the selected text and work with touch and VoiceOver.

Journey: open at 14:10, see the 14:30 meeting, inspect one relevant repository
marker, open today's note, tag a follow-up, close and reopen without loss. Test
in both palettes, with large text, keyboard visible, background/relaunch and
unreliable connectivity. Do not expand this release into a new task engine or
booking implementation.

### 2. Share bookable time, then trust the booking

This is the user's explicit next priority. MVP: one host, Google first, one
destination calendar, selected calendars across connected Google accounts used
for conflicts, a reusable unlisted link, duration, weekly availability, date
exceptions, buffers, minimum notice and booking horizon. An invitee chooses a
slot in an explicit time zone without creating an account, receives
confirmation, and can cancel or reschedule securely. The booking links back to
an event note in Enchiridion.

The implementation must earn these behaviors:

- Availability is the intersection of the host's allowed windows and the
  complement of busy intervals across **all selected calendars**, including the
  destination. Handle all-day, cancelled, transparent and recurring events
  deliberately. Never interpret a failed calendar read as free time.
- Use named IANA zones for availability rules and instants for reservations.
  Test daylight-saving gaps, repeated hours, travel and invitees in another
  zone; show the zone at selection and confirmation.
- Serialize overlapping bookings per host with expiring holds and idempotent
  requests. Recheck provider availability before writing; recover from a
  provider success followed by a network timeout without creating duplicates. An
  external calendar write can still race our check: document this boundary,
  reconcile and flag conflicts rather than promising absolute prevention.
- Confirm only after durable provider creation and booking-state persistence.
  OAuth must request the necessary calendar write permission through the
  existing credential owner; current read-only permission is insufficient. Never
  send provider tokens to the public booking page.
- Cancellation/rescheduling need scoped, revocable management tokens,
  idempotency and reconciliation with provider changes. Keep the original
  reservation until a replacement is safely secured.
- Public responses expose available slots, not private event names, attendees or
  graph content. Use rate limits, bounded input, verified invitee email before
  final confirmation, and abuse controls to prevent calendar/invitation spam. A
  link can be disabled immediately.

Acceptance: two people racing for overlapping slots yield one confirmed
reservation; retries yield no duplicate; provider outage yields no false
confirmation; a cross-zone booking and cancellation agree in both calendars.
Round-robin hosts, payments, group appointments and automatic AI scheduling
wait.

### 3. Turn captured work into commitments

Journey: select “send the proposal”, choose Task, set tomorrow and a reminder,
then find it in Today on iPhone and Mac. Complete on Watch; the source note
reflects the same task. A missed reminder remains discoverable in overdue work.

Create one canonical task identity with source-note link, status/completion
history, project, optional deadline, planned time/duration and reminder policy.
Deadline and calendar time block must remain distinct. Add Inbox, Today and
Upcoming before customizable boards. Support undo, recurring series with
occurrence identity and explicit completion-relative rules, and durable offline
mutations reconciled across devices. Provider issues may link to a task without
silently closing GitHub work when a local checkbox is tapped.

Reminder delivery needs permission/denial states, reschedule/cancel
reconciliation, cross-device duplicate policy and reboot/offline checks.
Notification scheduling success is not proof the user was alerted. Capture and
task completion must remain usable without connectivity; the rich editor needs
its own durable recovery strategy.

## When replacement becomes credible

Use a two-week personal pilot with the original tools retained. The exit
criterion is no lost changes, unexplained duplicates, missed commitments caused
by the app, or hidden sync failures across the user's actual accounts and
devices. Test recurring exceptions, all-day events, DST, offline edits, account
switching and deleted provider items. VoiceOver must reach every event/action;
subtle markers need sufficient contrast and non-color meaning; drag interactions
need button alternatives.

For Todoist migration, provide preview and a repeatable import with stable
source IDs; preserve projects, completion state, dates and supported
recurrence/reminders, and report unsupported fields explicitly. Export and
rollback must exist before asking the user to move their commitments. Start with
a small project. For calendar migration, connect the existing provider calendars
rather than copy events; retain provider IDs and avoid duplicate subscriptions.
A Google-only first release is a deliberate scope limit, not a replacement for
iCloud/Exchange users.

## Public front door, private workspace

The user proposes `rawkode.dev` as the public booking front door, with
Enchiridion supplying a limited API and the native app managing it. This is
viable as a routing boundary, not a reason to merge storage or authentication.
Source inspection of `websites/rawkode.dev/wrangler.jsonc` and
`astro.config.mjs` shows the site also hosts Alteran: `did:web:rawkode.dev`, PDS
handle/hostname `rawkode.dev`, `ALTERAN_DB` D1, `ALTERAN_BLOBS` R2, `SESSION` KV
and the `ALTERAN_SEQUENCER` Durable Object with an existing migration. These
declarations do not prove live federation health.

Recommended first architecture: public pages under a reserved `/book/…` path,
backed by an independently deployed booking Worker through a narrow service
binding or explicit `/api/booking/v1/…` routes. Keep Enchiridion's authenticated
management API and notebook private. Prefer this separation over cohosting
provider write logic in the personal-site Worker; it reduces coupled releases
and avoids granting the public website broad workspace access. Final namespaces
require an inventory of existing routes before implementation.

An Enchiridion Astro integration is a reasonable packaging option for those
pages and thin endpoint adapters. Its contract should explicitly name injected
routes, required service bindings, configuration, supported adapter/runtime and
authentication behavior. Integration Workers continue to own provider
credentials, grants and deployment. Do not let installing the package create or
migrate databases, inject a catch-all middleware, replace the site's Cloudflare
adapter, or acquire access to Alteran bindings. Reject route collisions during
setup; test alongside the installed Alteran integration. This proposal needs an
independent architecture review of route precedence, authorization and
deployment/rollback before migration. A plugin makes composition convenient; it
does not establish a security boundary by itself.

Only intended booking pages and endpoints may bypass the current workspace's
whole-site Cloudflare Access protection. A public invitee must not need a
workspace login, and this must not expose GraphQL, documents, account
administration or integration RPCs. Public requests contain an opaque, revocable
event-type/share-link identity; the server resolves the owner and its specific
calendar grant. A caller cannot supply an owner assertion or use an admin RPC.
Google write scopes require an OAuth configuration change and explicit owner
reconsent. Public availability responses stay minimal; rate limits and
private-cache rules apply independently of Access.

Before routing changes, inventory Alteran-generated identity discovery, XRPC,
authentication and federation routes and establish live probes. Preserve their
precedence, hostname, DID documents, signing identity, data bindings, storage
and Durable Object migration history. Do not run Enchiridion migrations against
PDS resources, widen PDS CORS, or reuse PDS sessions as workspace
authentication. Stage only new booking routes; verify existing site/PDS probes
plus booking isolation, then roll back those routes independently if needed.
Existing reservations and idempotency records must survive a frontend rollback.
No domain migration or PDS changes belong in the current home/editor release.

Open decisions: which calendar providers and Todoist features the user relies on
daily; whether booking requires Google Meet at launch; who receives
confirmations and from which approved sender; whether completion-relative
recurrence is needed in the first task pilot. These inform subsequent scope and
do not block the current home/editor release.

Later investments should follow observed friction: meeting preparation assembled
from linked notes, a short daily review of unfinished work, and suggested
follow-ups that require user acceptance. Do not add a generic AI dashboard,
autonomous calendar edits or more navigation simply to match a competitor's
feature count.

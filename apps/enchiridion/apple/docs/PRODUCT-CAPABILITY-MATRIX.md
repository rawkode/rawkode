# Enchiridion capability matrix

Assessed 13 September 2026 against checkout `36bf4cc0` and its working tree.
This is a bounded source audit and product recommendation, not evidence of
production behavior, successful installation, or exhaustive competitive parity.
Only this document was changed for the audit.

“Everything Tana and Fibery do” is a long-term ambition measured through user
workflows. It is not an acceptance criterion for the next release. The immediate
product remains a personal planner and connected notebook. Reliability, useful
structure and provider write safety come before adding more kinds of screens.

Current official documentation distinguishes **Tana Outliner** (the relevant
Supertag/graph comparator) from **Tana** (with its own interface, sharing and
MCP surfaces). The matrix names the surface rather than treating both as one
interchangeable feature set. See
[Tana's interface](https://tana.inc/learn/features/interface) and
[the Outliner connection guide](https://tana.inc/learn/guides/connect-tana-outliner).
Plan entitlements and exact feature limits require separate verification before
any migration promise; this assessment does not compare pricing.

## Capability families

“Implemented” below means code exists. “Partial” means useful primitives exist
but the complete workflow is absent or unqualified. “Missing” means no product
implementation was found in the reviewed paths, not proof about every file in
this monorepo. Repository links are relative to this document.

| Family                        | Official comparator baseline                                                                                                                                                                                                                                                                                                                        | Enchiridion evidence and gap                                                                                                                                                                                                                                                                                                                                                                          | Useful acceptance target                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supertags and types           | [Tana Outliner Supertags](https://outliner.tana.inc/learn/features/supertags) attach structured fields/configuration to nodes. [Fibery databases](https://developers.fibery.com/guides/http-api/databases) define entity schemas.                                                                                                                   | **Partial.** [Entity schema](../../core/entities/schema.ts), [storage](../../core/entities/src/storage.ts) and [Supertag manager](../../website/src/components/SupertagManager.vue) implement inheritance, typed/cardinality fields, defaults, required fields, revisions and archive impact. Native uses the shared editor. A schema primitive is not a complete reusable workflow/template library. | Create Client and Project types, inherit common fields, change a field safely, and see the same values after reopening on phone and Mac. Preview incompatible schema changes; preserve authored values and expose conflicts.                                                          |
| Relations and provenance      | [Tana nodes/references](https://outliner.tana.inc/learn/features/nodes-and-references) reuse canonical nodes. [Fibery features](https://fibery.com/features) include custom relations and rich-text/entity linking.                                                                                                                                 | **Partial.** Entity-reference fields, aliases, merge redirects, provider observations and user source preferences exist in the [entity model](../../core/entities/schema.ts). [Entity pane](../../website/src/components/EntityPane.vue) exposes linked structure. No general relation traversal/reporting or formula/rollup authoring UI was found.                                                  | A meeting links to one client and two tasks. Renaming/merging the client preserves links. Provider refresh never silently overwrites the user's chosen value; show where each value came from.                                                                                        |
| Queries and views             | [Tana search nodes](https://outliner.tana.inc/learn/features/search-nodes) are reusable graph queries; [views](https://outliner.tana.inc/learn/features/views) present information in different layouts. Fibery documents boards, tables, calendars, timelines and charts in its [product overview](https://fibery.com/101-questions-about-fibery). | **Partial.** [Entity GraphQL](../../core/entities/graphql.ts) supports text/root-limited lookup; app panes provide bespoke calendar, people and repository views. These are not user-defined saved queries, arbitrary filters, relation joins, grouping or computed measures.                                                                                                                         | Save “open tasks for this client due this week”; embed it in the client note; switch list/board without copying records. Updates appear after mutations and refresh. Pagination, archived records, time zone and empty results have defined behavior.                                 |
| Tasks and calendar            | [Tana calendar integration](https://outliner.tana.inc/learn/features/calendar-integration) connects calendar context to notes. Fibery's configurable entities/views can model work; this does not establish reminder or scheduling equivalence.                                                                                                     | **Partial.** Checkboxes and `base:task` fields exist; [day timeline](../Sources/SharedUI/DayTimelineView.swift), [Google ingestion](../../integrations/google/src/sync.ts) and event notes exist. [OAuth scopes](../../integrations/oauth/src/providers.ts) remain calendar read-only. Canonical task recurrence/reminders, calendar writes and bookings are missing.                                 | Turn a selected sentence into a task; schedule it without confusing deadline with time block; complete it once across devices. A provider event can be rescheduled only with granted write access and confirmed provider outcome.                                                     |
| Automations and formulas      | [Tana command nodes](https://outliner.tana.inc/learn/features/command-nodes) compose actions. [Fibery features](https://fibery.com/features) describe automation rules; its [overview](https://fibery.com/101-questions-about-fibery) describes recurring rules.                                                                                    | **Missing as a user product.** Provider cron/sync jobs and editor commands exist, but they are not configurable triggers, conditions, formulas or automation runs.                                                                                                                                                                                                                                    | Start with “when this task completes, create the next occurrence.” Retry without duplication; prevent loops; attribute the write; show failure/retry history; disable the rule immediately. No autonomous calendar mutation hidden behind an AI suggestion.                           |
| Collaboration and history     | [Tana Outliner workspaces](https://outliner.tana.inc/learn/features/workspaces) document workspace members, edit attribution and notifications. Fibery documents sharing and change history in [features](https://fibery.com/features).                                                                                                             | **Missing team workflow.** The [product brief](../../PRODUCT.md) targets one signed-in owner. Document revision conflicts and entity audit events exist, but no complete shared editing, comments, assignments, presence or restore interface was found. Conflict detection is not real-time collaboration.                                                                                           | Two people edit the same shared project without silent loss; comments resolve to stable entities; assignment notifications have delivery state. Restore produces an attributable new revision.                                                                                        |
| Permissions and sharing       | [Outliner editor permissions](https://outliner.tana.inc/learn/features/outline-editor) are workspace-level. [Tana sharing](https://tana.inc/help/collaboration-and-sharing) belongs to its separate document surface. [Fibery permissions](https://fibery.com/features/permissions) include granular sharing, groups and access templates.          | **Personal isolation implemented; sharing missing.** [Entities](../../core/entities/src/index.ts) and [documents](../../core/documents/src/index.ts) scope storage by trusted owner; [Access configuration](../../website/access.ts) gates the website. This is not per-project/team/field authorization.                                                                                             | Before team use, define ownership, membership, roles and revocation. Enforce them server-side for queries, relations, exports and mutations; inaccessible related data cannot leak through counts, search or automation.                                                              |
| Search                        | [Tana search/navigation](https://outliner.tana.inc/help/search-and-finding) combines search with graph context; Fibery lists full-text search in [features](https://fibery.com/features).                                                                                                                                                           | **Partial.** Native [search](../Sources/SharedUI/PhoneTodayView.swift) filters saved events, people, activity and captures; entity lookup searches indexed labels/aliases. No unified full-document search, saved advanced search or permissions-aware cross-workspace index was found.                                                                                                               | Find a phrase in a note and return to its location, alongside matching people/tasks with clear result types. Explain cached versus server results; deleted/private content disappears promptly.                                                                                       |
| Capture, transcription and AI | [Tana meeting agent](https://outliner.tana.inc/docs/meeting-agent) documents live transcription and structured meeting workflows. Fibery exposes AI features in its [feature catalog](https://fibery.com/features); this audit does not establish equivalent native meeting transcription.                                                          | **Capture partial; transcription missing.** [Capture spool](../Sources/Core/CaptureSpool.swift), [Watch bridge](../Sources/Platform/WatchBridge.swift) and [Shortcuts intent](../Sources/Platform/CaptureIntent.swift) exist. System keyboard dictation is not a recording/transcription pipeline. No recording consent, transcript retention, speaker correction or model-backed workflow was found. | Capture offline, show local/pending/server receipt distinctly, then attach to a project without duplicate creation. Later transcription requires explicit recording controls, recoverable upload, transcript/source links, retention/deletion and review before creating commitments. |
| APIs and integrations         | [Tana Outliner Input API](https://outliner.tana.inc/learn/features/input-api) is principally input with limited editing; do not assume full read/write parity. [Fibery integration API](https://developers.fibery.com/guides/integrations/overview) supports integration development.                                                               | **Internal primitives implemented; public platform missing.** Owner-scoped GraphQL/document endpoints and Google/GitHub service bindings exist. No supported external developer token lifecycle, scoped public API, webhook delivery contract or connector SDK was found.                                                                                                                             | A client can create one capture using a revocable least-privilege credential; retries are idempotent; pagination/versioning/rate limits are documented. Third-party integrations never call private owner-asserting admin RPCs directly.                                              |

## Five gaps with the highest user value

The [delivery board](../../product/DELIVERY.md) owns priority and sequencing.
The user's explicit GPT Live and live meeting-note requests are P0, alongside
reliable delivery and independent offline projections. The older productivity
roadmap's booking-first sequence does not override that direction.

1. **Trustworthy persistence and retrieval.** Qualify the current day, note and
   capture workflow while independent voice and meeting engineering proceeds.
   The native vault now caches connected context and a real note preview; the
   older roadmap's cache/entry-style notes are historical. Verify selected-day
   loading, return-to-now, note reopen, account switching and stale/partial
   states on real devices. A durable offline rich-editor outbox and unified
   document search still need qualification or implementation. Dependencies:
   stable document/entity IDs, revision semantics and independently preserved
   provider projections.
2. **GPT Live and live meeting notes.** Deliver authenticated conversation and
   durable meeting transcription as distinct P0 streams. Conversation needs
   server-owned credentials, a verified transport, scoped code-mode tools and
   microphone/mute/end/reconnect behavior. Meetings need stable transcript
   segment IDs, provisional/final revisions, interruption recovery, corrections
   and explicit recording controls. Summaries and proposed tasks link to
   retained transcript evidence; they must not replace it. Device qualification
   follows the iPhone foundation into Mac and CarPlay as the delivery board
   specifies.
3. **Canonical commitments.** Build Task Inbox/Today/Upcoming and task-from-note
   after the voice/meeting foundations, before generic boards. Depend on stable
   task identity, recurrence occurrence identity, reminder policy and
   cross-device mutation reconciliation. Completion must not silently close an
   associated GitHub issue. Voice-proposed commitments require explicit user
   acceptance.
4. **Bookable time and Google write operations.** Preserve the booking ambition
   and isolation constraints from
   [PRODUCTIVITY-ROADMAP](PRODUCTIVITY-ROADMAP.md), sequenced after the P0
   voice/meeting work as BOOK-01 specifies. Depend on owner reconsent,
   least-privilege calendar grants, provider mutation reconciliation and a
   durable booking state machine.
5. **Useful graph queries and safe delegation.** Make Client → Project → Meeting
   → Task navigable and queryable with validated fields, relation indexes,
   pagination and defined date semantics. Add explicit actor, scope and
   attributable mutations before shared automations, team collaboration and
   external API access. Start with useful saved views; broader formulas, charts,
   maps and whiteboards follow demonstrated need.

## Shipping sequence and exit gates

**Reliability and P0 foundations:** qualify the existing phone dock/day
selection/editor and capture paths in Dawn/Dark, Dynamic Type and VoiceOver;
advance GPT Live transport/tools and durable meeting transcript work in parallel
where dependencies permit. Exercise restart, offline, midnight, DST, account
switch and provider outage. Preserve export/recovery and distinguish local,
uploaded and confirmed states. A two-week personal pilot qualifies a
daily-driver replacement claim; it is not a blanket gate blocking independent
engineering.

**First new user workflows:** real microphone conversation grounded in the day,
and live meeting notes with visible start/pause/stop, recoverable retained
transcript and reviewable follow-ups. Validate real transport and device audio
behavior, not only fixtures. The [delivery board](../../product/DELIVERY.md)
defines the exact VOICE/MEET dependencies and subsequent Mac/CarPlay work.

**Following investments:** reliable tasks and saved project/client views, then
one-host Google booking through one destination calendar and selected conflict
calendars, following TASK-01 and BOOK-01 priority. Each increment needs an
end-to-end acceptance journey rather than a new empty navigation destination.

**Later parity:** configurable automation, team collaboration/permissions,
public API/connector tooling, migration import/export, additional visualizations
and team administration. GPT Live and live meeting transcription are already P0,
not postponed to this category. Track each capability by supported workflow,
platform, evidence date and known limit. Do not publish a percentage-parity
score: these products evolve, and one checkbox can hide different data
guarantees.

## Bookings, public Astro and PDS isolation

Keep the roadmap's public `rawkode.dev` proposal narrow: reserved `/book/…`
pages and versioned booking endpoints backed by an independently deployed
booking Worker. An Astro integration may install thin routes and a service
binding; it must not own OAuth secrets, inject catch-all middleware, replace the
Cloudflare adapter or run storage migrations during package installation.

Retain the existing Alteran PDS hostname/DID, identity discovery, XRPC, auth and
federation routes, bindings, signing identity and Durable Object migration
history. Inventory route precedence and baseline probes before adding routes.
Booking and notebook storage must never use PDS bindings or sessions. These are
constraints carried from the inspected roadmap; this audit did not verify live
PDS health or change its deployment.

Only the intended booking routes may bypass workspace Access. Public callers
provide an opaque revocable link identity, never an owner assertion. Return
available slots, not private event titles or attendees. Keep management,
GraphQL, documents and integration admin RPCs private.

Google writes require changed OAuth scopes and explicit owner reconsent. The
booking server must recheck availability and serialize competing reservations,
use stable idempotency keys, reconcile ambiguous provider responses and confirm
only after the provider accepts the event. Cancellation/rescheduling tokens must
be scoped and revocable. Test racing invitees, retries, timezone/DST, provider
outages and rollback; preserve reservation/idempotency records across a frontend
rollback. No PDS migration belongs in this work.

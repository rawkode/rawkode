import * as Schema from "effect/Schema"
import { Email } from "./auth.js"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 5 domain-extension task, item 3: `GatekeeperBinding` — the plan's own naming
// ("gatekeeperBindings — per-workspace external connections, edge-record shape per multi-gadget.md
// decision #3", plan §"Storage & domain model") for the workspace-level record of "this workspace has
// connected external service X, configured this way." One `GatekeeperBinding` row is created per
// successful `googleCalendarOAuthCallback` (gatekeeper-rpc.ts) and is what `disconnectGoogleCalendar`
// deletes, `syncGoogleCalendar` looks up to find the connection to sync, and `listCalendarEvents`
// implicitly reads through.
//
// **`gatekeeperKind` is a literal union, extensible** (task's own wording) — today's one member,
// `"google-calendar"`, is Phase 5's first and only gatekeeper (plan §"Phased delivery": "Phase 5
// — First gatekeeper: Google Calendar + Bookmarks... further gatekeepers follow the Phase 5
// template" — Phase 7). Adding a second gatekeeper kind later means widening this literal and
// `GatekeeperBindingConfig`'s union below, not reworking either.
//
// **`config` is a per-kind discriminated payload**, per the task's own example
// (`{kind:"google-calendar", calendarId, mode: "selected"|"allVisible"}`). `mode` mirrors the
// plan's own "Observer strategy for Calendar" paragraph verbatim: "a selected-calendar binding =
// Strategy B... an allVisible-availability binding = Strategy C" (`docs/observers.md` §9.1,
// reused directly by the Decisions pre-work stage's `observer-verification.ts` in
// `gatekeeper-google-calendar`) — `mode` is not a free-form string precisely because it is the
// exact input the next stage's observer-verification wiring switches on to choose Strategy B vs.
// C for this binding.
//
// **Why `gatekeeperKind` is a top-level field, duplicating `config.kind`**: every other
// discriminated-union wire shape in this package (`ChatBindingTarget`, `PermissionEdge`) lets the
// union's own tag serve as the sole discriminator, with no denormalized copy sitting beside it.
// `GatekeeperBinding.gatekeeperKind` breaks that pattern deliberately: a future
// `typed-storage-effect` collection for `gatekeeperBindings` needs a flat, indexable field to look
// up "does this workspace already have a google-calendar binding" without decoding `config` first (the
// same reason `Collaborator`/`ShareLink` keep `workspaceId` as a flat top-level field rather than
// nesting every record under a per-workspace sub-object) — the tradeoff is an invariant a future
// `GatekeeperService` write path must maintain (`gatekeeperKind === config.kind`, always), not
// something this schema enforces structurally (`effect/Schema` has no cross-field equality
// constraint primitive that wouldn't be more confusing than a plain code-review-time invariant
// here).

/** Extensible literal union of gatekeeper kinds a workspace can bind to — see header comment. */
export const GatekeeperKind = Schema.Literal("google-calendar")
export type GatekeeperKind = typeof GatekeeperKind.Type

/** Google Calendar's own binding config — the task's exact example shape. `calendarId` is the
 *  provider's own calendar id (e.g. Google's `"primary"` or a real calendar address) — a plain
 *  string, not `EntityId`: like `CalendarEvent.providerEventId`, it is a provider-namespaced
 *  identifier this codebase never mints itself. `mode` selects the observer-verification strategy
 *  this binding is governed by, per the header comment. */
export class GoogleCalendarBindingConfig extends Schema.Class<GoogleCalendarBindingConfig>(
  "GoogleCalendarBindingConfig"
)({
  kind: Schema.Literal("google-calendar"),
  calendarId: Schema.String.pipe(Schema.minLength(1)),
  mode: Schema.Literal("selected", "allVisible")
}) {}

/** The per-kind discriminated payload union — one member today (`GoogleCalendarBindingConfig`),
 *  declared as a `Schema.Union` (not a bare alias to the one member) so a second gatekeeper kind's
 *  own config class slots in later without reshaping every existing caller's `Schema.Union(...)`
 *  call site, mirroring `ChatBindingTarget`'s identical one-real-member-today precedent (see that
 *  file's header comment for the same "declare the full shape now, deliver members over time"
 *  reasoning). */
export const GatekeeperBindingConfig = Schema.Union(GoogleCalendarBindingConfig)
export type GatekeeperBindingConfig = typeof GatekeeperBindingConfig.Type

/**
 * A workspace's connection to one external gatekeeper-governed resource, per the task's own
 * `{id, workspaceId, gatekeeperKind, boundBy, config, createdAt}` shape.
 */
export class GatekeeperBinding extends Schema.Class<GatekeeperBinding>("GatekeeperBinding")({
  id: EntityId,
  workspaceId: EntityId,
  gatekeeperKind: GatekeeperKind,
  /** The account that authorized this binding (ran the OAuth flow) — `Email`, Athenaeum's sole
   *  account-identity type, same as `Collaborator.profileId`/`ShareLink.creatorId`. Not
   *  necessarily the workspace's owner: any collaborator with sufficient role (a future stage's
   *  concern, per this task's hard constraint that every governed-workspace RPC method gates on
   *  `requireRoleForGovernedWorkspace` — see gatekeeper-rpc.ts's own header comment for why that
   *  gating is deliberately NOT implemented in this schema-only stage) may be able to connect a
   *  gatekeeper, and this field is how a later audit/UI answers "who connected this." */
  boundBy: Email,
  config: GatekeeperBindingConfig,
  createdAt: IsoDateTimeString
}) {}

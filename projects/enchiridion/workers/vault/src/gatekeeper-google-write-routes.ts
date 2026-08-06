// @enchiridion/worker-vault — HTTP proxy routes for gatekeeper-google's
// write RPCs (plan §"Live Backend Connectivity (P8)": "vault ->
// gatekeeper-google HTTP proxy route(s) for the write RPCs (Gmail triage,
// RSVP, sendEmail) — authenticated identically to every other vault
// route").
//
// WHY THIS IS NEW SURFACE ON *VAULT*, NOT A NEW HOLE IN GATEKEEPER-GOOGLE:
// `./graphql/yoga.ts`'s `GATEKEEPER_GOOGLE` binding comment (and
// `workers/gatekeeper-google/src/index.ts`'s own header, "Fix 4") document
// an adversarial-review BLOCKER this codebase already fixed once: a plain
// Service Binding's `.fetch()` call dispatches to the TARGET worker's own
// PUBLIC `fetch()` handler, so routing vault's reads through
// `env.GATEKEEPER_GOOGLE.fetch(...)` against gatekeeper-google's HTTP
// routes would have had zero application-layer auth. That's why
// `GATEKEEPER_GOOGLE` is a NAMED-ENTRYPOINT Service Binding (real Workers
// RPC to `GmailReadModel`, never `.fetch()`) used only inside vault's
// GraphQL resolvers — see that binding's own comment for the full
// writeup. THIS module preserves that exact discipline for the write
// direction: `GATEKEEPER_GOOGLE_CALENDAR_WRITE`/`GATEKEEPER_GOOGLE_
// GMAIL_WRITE` below are ALSO named-entrypoint Service Bindings
// (`entrypoint: "CalendarWriteModel"`/`"GmailWriteModel"`,
// `wrangler.jsonc`) — real Workers RPC calls to gatekeeper-google's real
// `WorkerEntrypoint` classes, never `.fetch()` against it. Confirm this
// for yourself against `workers/gatekeeper-google/src/index.ts`'s own
// `fetch()` handler: it still has ZERO HTTP route surface for Calendar or
// Gmail writes (`/calendar/*` and every Gmail path 404 unconditionally) —
// gatekeeper-google gained no new public surface from this task. What's
// new is vault's OWN public surface: these routes, gated by the SAME
// Cloudflare Access check every other vault route already uses (see
// below), forwarding an already-authenticated device request over a
// private, Workers-RPC-only internal binding.
//
// AUTH: identical mechanism to `/blobs/*`/`/sync` (`../access-auth.ts`) —
// no second auth mechanism invented here. Unlike `/blobs/*`/`/sync` (whose
// check lives in `../index.ts`, since those routes just forward a
// `Request` into `VaultDO.fetch()`), this module's own exported
// `handleGatekeeperGoogleWriteRequest` does the check itself, mirroring
// `../graphql/yoga.ts`'s `handleGraphQLRequest` — both need to parse/
// dispatch on more than one shape of request body before forwarding, so
// keeping the auth check inside the one function that owns that dispatch
// keeps it directly unit-testable (this file's own `.test.ts`) without
// needing a live `../index.ts` fetch-handler test. The optional third
// `verifyOptions` parameter exists ONLY for tests (mirrors
// `access-auth.ts`'s own `VerifyAccessOptions` escape hatch, and
// `access-auth.test.ts`'s real-JWT-signing test style) — `../index.ts`'s
// real call site passes no third argument.
//
// ROUTE CONTRACT — every route below is `POST`, body is the RPC method's
// single JSON input object (`./gatekeeper-google-write-types.ts`), response
// is the `PendingApproval` gatekeeper-google's `proposeX` RPC method
// returned, JSON-encoded, passed through VERBATIM (vault does not
// interpret or reshape it):
//
//   POST /gatekeeper-google/calendar/create-event  -> CalendarWriteModel.createEvent
//   POST /gatekeeper-google/calendar/rsvp          -> CalendarWriteModel.rsvp
//   POST /gatekeeper-google/gmail/archive-thread   -> GmailWriteModel.archiveThread
//   POST /gatekeeper-google/gmail/apply-label      -> GmailWriteModel.applyLabel
//   POST /gatekeeper-google/gmail/remove-label     -> GmailWriteModel.removeLabel
//   POST /gatekeeper-google/gmail/mark-read        -> GmailWriteModel.markRead
//   POST /gatekeeper-google/gmail/mark-unread      -> GmailWriteModel.markUnread
//   POST /gatekeeper-google/gmail/send             -> GmailWriteModel.sendEmail
//
// `confirmApproval`/`getApproval`/`listPendingApprovals` are DELIBERATELY
// NOT proxied here — out of this task's scope (plan P8 scope item 1 lists
// exactly "Gmail triage ... calendar (createEvent/rsvp), email
// (sendEmail)"); the in-app confirmation flow is future native-app work
// per `workers/gatekeeper-google/src/index.ts`'s own "STILL NOT
// IMPLEMENTED" note.
//
// VALIDATION: none beyond JSON-parsing the body — gatekeeper-google's own
// `proposeX` functions (`write-model.ts`) are where every real check lives
// (input validation, e.g. `validateSendEmailInput`'s header-injection
// guard; the `threadPageID`/`eventPageID` -> real-provider-ID resolution
// this same plan phase added for RSVP). Vault's job here is exactly what
// `/blobs/*` already established for a different payload shape: an
// authenticated, dumb forward — never a second place business logic could
// drift from gatekeeper-google's own.
//
// A non-OK RPC call (a thrown error from `write-model.ts`'s `proposeX` —
// e.g. `TriageThreadNotFoundError`/`RsvpEventNotFoundError`/
// `SendEmailValidationError`) is turned into a `502` carrying the error's
// message — never an unhandled exception crashing this Worker's `fetch()`,
// matching `../graphql/yoga.ts`'s "re-wrap any caught RPC error, never a
// silent empty result" posture.

import { accessDenyResponse, type AccessEnv, verifyAccessRequest, type VerifyAccessOptions } from "./access-auth";
import type {
  ApplyLabelInput,
  ArchiveThreadInput,
  CreateEventInput,
  MarkReadInput,
  MarkUnreadInput,
  PendingApproval,
  RemoveLabelInput,
  RsvpInput,
  SendEmailInput,
} from "./gatekeeper-google-write-types";

export interface GatekeeperGoogleWriteEnv extends AccessEnv {
  /** NAMED-ENTRYPOINT Service Binding to `workers/gatekeeper-google`'s
   *  `CalendarWriteModel` `WorkerEntrypoint` (`entrypoint:
   *  "CalendarWriteModel"`, `wrangler.jsonc`) — real Workers RPC, never
   *  `env.GATEKEEPER_GOOGLE_CALENDAR_WRITE.fetch(...)`. See this file's
   *  header. */
  GATEKEEPER_GOOGLE_CALENDAR_WRITE: Fetcher;
  /** NAMED-ENTRYPOINT Service Binding to `workers/gatekeeper-google`'s
   *  `GmailWriteModel` `WorkerEntrypoint` (`entrypoint: "GmailWriteModel"`,
   *  `wrangler.jsonc`) — real Workers RPC, never
   *  `env.GATEKEEPER_GOOGLE_GMAIL_WRITE.fetch(...)`. See this file's
   *  header. */
  GATEKEEPER_GOOGLE_GMAIL_WRITE: Fetcher;
}

/** The slice of `CalendarWriteModel`'s RPC surface this worker calls — a
 *  local, minimal structural type, matching `../graphql/yoga.ts`'s
 *  `GmailReadModelStub` pattern exactly (see that file's own doc comment
 *  for why a structural cast, not a generic `Service<T>` binding type, is
 *  this codebase's established convention here). */
interface CalendarWriteModelStub {
  createEvent(input: CreateEventInput): Promise<PendingApproval>;
  rsvp(input: RsvpInput): Promise<PendingApproval>;
}

/** The slice of `GmailWriteModel`'s RPC surface this worker calls — sibling
 *  of `CalendarWriteModelStub` above. */
interface GmailWriteModelStub {
  archiveThread(input: ArchiveThreadInput): Promise<PendingApproval>;
  applyLabel(input: ApplyLabelInput): Promise<PendingApproval>;
  removeLabel(input: RemoveLabelInput): Promise<PendingApproval>;
  markRead(input: MarkReadInput): Promise<PendingApproval>;
  markUnread(input: MarkUnreadInput): Promise<PendingApproval>;
  sendEmail(input: SendEmailInput): Promise<PendingApproval>;
}

function asCalendarWriteModelStub(fetcher: Fetcher): CalendarWriteModelStub {
  return fetcher as unknown as CalendarWriteModelStub;
}

function asGmailWriteModelStub(fetcher: Fetcher): GmailWriteModelStub {
  return fetcher as unknown as GmailWriteModelStub;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, error: string): Response {
  return jsonResponse({ error }, status);
}

/** Upper bound on a request body's declared `Content-Length` — every route
 *  here takes a small control-plane JSON object (the largest field,
 *  `SendEmailInput.body`, is still plain email text, not an attachment —
 *  attachments have their own R2/`blob_<sha256>` path entirely, per
 *  `gmail-body-ingest.ts`'s file header). 1 MiB is comfortably generous for
 *  that while still bounding worst-case memory `request.json()` buffers
 *  before any validation runs — mirrors `blob-routes.ts`'s own
 *  `MULTIPART_THRESHOLD_BYTES` reasoning (bound memory via `Content-Length`
 *  before reading the body), applied here to a JSON body instead of raw
 *  blob bytes. A request with no `Content-Length` header at all (or an
 *  unparsable one) is NOT rejected here — same "can't bound what isn't
 *  declared" limitation `blob-routes.ts`'s own multipart-threshold check
 *  has — `request.json()`'s own failure mode (or gatekeeper-google's real
 *  RPC validation) is the backstop for that case. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `../index.ts`'s `/gatekeeper-google/*` routes call this — verifies
 *  Cloudflare Access first (see this file's header on why the check lives
 *  in this one function rather than split across `../index.ts`), then
 *  dispatches by exact pathname to the matching RPC call over the real
 *  named-entrypoint Service Binding, and returns the RPC's own result (or a
 *  502 wrapping any thrown error) verbatim. Unknown paths/methods 404/405,
 *  matching `../index.ts`'s own "not found" posture for every other
 *  unimplemented route. */
export async function handleGatekeeperGoogleWriteRequest(
  request: Request,
  env: GatekeeperGoogleWriteEnv,
  verifyOptions: VerifyAccessOptions = {},
): Promise<Response> {
  const access = await verifyAccessRequest(request, env, verifyOptions);
  if (!access.ok) {
    return accessDenyResponse(access);
  }

  if (request.method !== "POST") {
    return errorResponse(405, "method not allowed — every /gatekeeper-google/* route is POST");
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorResponse(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`);
  }

  const url = new URL(request.url);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid JSON body");
  }

  // A shape mismatch this obviously wrong (not a JSON object at all) is a
  // malformed VAULT request, not an RPC failure — reject it 400 here
  // rather than letting it surface as a misleading 502 once gatekeeper-
  // google's real `proposeX` validation throws on a missing/wrong-typed
  // field deep inside. Anything past this coarse check (a plausible object
  // missing/mistyping a specific field) is still gatekeeper-google's own
  // `proposeX` validation's job, per this file's header — vault does not
  // duplicate that business-shape validation.
  if (!isPlainObject(body)) {
    return errorResponse(400, "request body must be a JSON object");
  }

  const calendar = asCalendarWriteModelStub(env.GATEKEEPER_GOOGLE_CALENDAR_WRITE);
  const gmail = asGmailWriteModelStub(env.GATEKEEPER_GOOGLE_GMAIL_WRITE);

  try {
    if (url.pathname === "/gatekeeper-google/calendar/create-event") {
      return jsonResponse(await calendar.createEvent(body as CreateEventInput));
    }
    if (url.pathname === "/gatekeeper-google/calendar/rsvp") {
      return jsonResponse(await calendar.rsvp(body as RsvpInput));
    }
    if (url.pathname === "/gatekeeper-google/gmail/archive-thread") {
      return jsonResponse(await gmail.archiveThread(body as ArchiveThreadInput));
    }
    if (url.pathname === "/gatekeeper-google/gmail/apply-label") {
      return jsonResponse(await gmail.applyLabel(body as ApplyLabelInput));
    }
    if (url.pathname === "/gatekeeper-google/gmail/remove-label") {
      return jsonResponse(await gmail.removeLabel(body as RemoveLabelInput));
    }
    if (url.pathname === "/gatekeeper-google/gmail/mark-read") {
      return jsonResponse(await gmail.markRead(body as MarkReadInput));
    }
    if (url.pathname === "/gatekeeper-google/gmail/mark-unread") {
      return jsonResponse(await gmail.markUnread(body as MarkUnreadInput));
    }
    if (url.pathname === "/gatekeeper-google/gmail/send") {
      return jsonResponse(await gmail.sendEmail(body as SendEmailInput));
    }
  } catch (error) {
    // A thrown propose-time rejection (TriageThreadNotFoundError /
    // RsvpEventNotFoundError / SendEmailValidationError / any other RPC
    // failure) — never an unhandled exception, matching yoga.ts's
    // GraphQLError re-wrap posture. 502 (not 400): the failure is real and
    // gatekeeper-google-side, not a malformed vault request.
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(502, message);
  }

  return new Response(
    "not found — implemented routes: POST /gatekeeper-google/calendar/create-event, " +
      "POST /gatekeeper-google/calendar/rsvp, POST /gatekeeper-google/gmail/archive-thread, " +
      "POST /gatekeeper-google/gmail/apply-label, POST /gatekeeper-google/gmail/remove-label, " +
      "POST /gatekeeper-google/gmail/mark-read, POST /gatekeeper-google/gmail/mark-unread, " +
      "POST /gatekeeper-google/gmail/send.\n" +
      "Plan: /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md",
    { status: 404 },
  );
}

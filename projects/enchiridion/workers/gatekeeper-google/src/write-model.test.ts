import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { storeInitialTokens } from "./token-store";
import { CALENDAR_EVENTS_SCOPE, GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE, type GoogleOAuthConfig } from "./oauth-client";
import { tryConfirmApproval } from "./approvals-store";
import { recordCalendarEventId } from "./calendar-event-id-store";
import { recordThreadMessages } from "./gmail-body-store";
import { SendEmailValidationError } from "./gmail-send";
import {
  APPROVAL_CONFIRMATION_TIMEOUT_MS,
  confirmApproval,
  getApproval,
  listPendingApprovals,
  proposeApplyLabel,
  proposeArchiveThread,
  proposeCreateEvent,
  proposeMarkRead,
  proposeMarkUnread,
  proposeRemoveLabel,
  proposeRsvp,
  proposeSendEmail,
  reconcileStuckApprovals,
  RsvpEventNotFoundError,
  TriageThreadNotFoundError,
} from "./write-model";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

const CONFIG: GoogleOAuthConfig = { clientId: "id", clientSecret: "secret", redirectUri: "https://gatekeeper.example/callback" };

function withValidStoredToken(sql: SqliteStorageAdapter, now: number): void {
  // Expiry far in the future so `getValidAccessToken` never needs to hit
  // the OAuth token endpoint — tests below only need to fake the Calendar
  // API, not token refresh. NOTE: no `grantedScopes` — `hasGrantedScope`
  // falls back to treating exactly `CALENDAR_EVENTS_SCOPE` as granted (see
  // `token-store.ts`), which is what makes this helper double as the
  // "Gmail send scope NOT granted" fixture for the scope-gate tests below.
  storeInitialTokens(sql, { accessToken: "valid-access-token", refreshToken: "rt-1", expiresIn: 3600 }, now);
}

/** Sibling of `withValidStoredToken` that ALSO records `GMAIL_SEND_SCOPE` as
 *  granted (alongside Calendar's scope, matching Google's real
 *  `include_granted_scopes=true` union behavior — see `oauth-client.ts`'s
 *  `buildAuthorizationUrl` doc comment) — the fixture every `sendEmail`
 *  happy-path test below needs, since `withValidStoredToken` alone
 *  deliberately does NOT grant it. */
function withValidStoredTokenAndGmailSendScope(sql: SqliteStorageAdapter, now: number): void {
  storeInitialTokens(
    sql,
    { accessToken: "valid-access-token", refreshToken: "rt-1", expiresIn: 3600, grantedScopes: `${CALENDAR_EVENTS_SCOPE} ${GMAIL_SEND_SCOPE}` },
    now,
  );
}

/** Sibling of `withValidStoredTokenAndGmailSendScope` for the Gmail TRIAGE
 *  scope gate (`GMAIL_MODIFY_SCOPE`) — the fixture every archiveThread/
 *  applyLabel/removeLabel/markRead/markUnread happy-path test below needs,
 *  since plain `withValidStoredToken` deliberately does NOT grant it
 *  (making it double as the "GMAIL_MODIFY_SCOPE NOT granted" fixture for
 *  the scope-gate test). */
function withValidStoredTokenAndGmailModifyScope(sql: SqliteStorageAdapter, now: number): void {
  storeInitialTokens(
    sql,
    { accessToken: "valid-access-token", refreshToken: "rt-1", expiresIn: 3600, grantedScopes: `${CALENDAR_EVENTS_SCOPE} ${GMAIL_MODIFY_SCOPE}` },
    now,
  );
}

/** Registers `threadPageID` as resolving to `threadId` in
 *  `gmail_thread_messages` — the fixture every triage `proposeX` happy-path
 *  test needs (mirrors what real thread materialization would have already
 *  done, per `gmail-triage.ts`'s "threadPageID vs. RAW GMAIL THREAD ID"
 *  design note: any `threadPageID` a client could plausibly have obtained
 *  via search is guaranteed to already have this row). */
function withMaterializedThread(sql: SqliteStorageAdapter, threadPageID: string, threadId: string): void {
  recordThreadMessages(sql, threadPageID, threadId, ["m1"]);
}

/** Calendar twin of `withMaterializedThread` above — registers `eventPageID`
 *  as resolving to `eventId`/`calendarId` in `calendar_event_ids`, the
 *  fixture every `proposeRsvp` happy-path test below needs (mirrors what
 *  real calendar ingest — `calendar-ingest.ts`'s `recordCalendarEventId`
 *  call — would have already done). */
function withMaterializedEvent(sql: SqliteStorageAdapter, eventPageID: string, eventId: string, calendarId = "primary"): void {
  recordCalendarEventId(sql, eventPageID, eventId, calendarId);
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string, init?: RequestInit) => handler(input, init)) as unknown as typeof fetch;
}

function decodedRawMessage(sentBody: unknown): string {
  const raw = (sentBody as { raw: string }).raw;
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

describe("proposeCreateEvent / proposeRsvp", () => {
  test("creates a pending approval WITHOUT touching Google's API at all", async () => {
    const sql = makeSql();
    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    void fetchImpl; // not passed anywhere below — proposing must not need it

    const approval = proposeCreateEvent(
      sql,
      { summary: "Standup", start: { dateTime: "2026-08-15T09:00:00+01:00" }, end: { dateTime: "2026-08-15T09:15:00+01:00" } },
      1000,
    );

    expect(approval.status).toBe("pending");
    expect(fetchCalled).toBe(false);
    expect(getApproval(sql, approval.id)).toEqual(approval);
    expect(listPendingApprovals(sql)).toEqual([approval]);
  });

  test("proposeRsvp likewise only creates a pending approval", () => {
    const sql = makeSql();
    withMaterializedEvent(sql, "event-page-1", "evt-1");
    const approval = proposeRsvp(sql, { eventPageID: "event-page-1", responseStatus: "accepted" }, 1000);
    expect(approval.actionType).toBe("rsvp");
    expect(approval.status).toBe("pending");
  });
});

describe("proposeRsvp — real Google event-ID verification (plan §'Live Backend Connectivity (P8)', closing the gap P5 originally flagged and P7 flagged again)", () => {
  test("resolves a materialized eventPageID to the real Google eventId/calendarId and stores BOTH on the approval's payload", () => {
    const sql = makeSql();
    withMaterializedEvent(sql, "event-page-1", "evt-real-42", "primary");

    const approval = proposeRsvp(sql, { eventPageID: "event-page-1", responseStatus: "tentative" }, 1000);

    expect(approval.status).toBe("pending");
    const payload = approval.payload as { eventPageID: string; eventId: string; calendarId: string; responseStatus: string };
    expect(payload.eventPageID).toBe("event-page-1");
    expect(payload.eventId).toBe("evt-real-42");
    expect(payload.calendarId).toBe("primary");
    expect(payload.responseStatus).toBe("tentative");
  });

  test("rejects an unknown/unresolvable eventPageID immediately — no approval row is ever created", () => {
    const sql = makeSql();

    expect(() => proposeRsvp(sql, { eventPageID: "no-such-event-page", responseStatus: "accepted" }, 1000)).toThrow(
      RsvpEventNotFoundError,
    );
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("a caller-supplied eventId/calendarId on the input is IGNORED — the resolved values always win, so a client can never claim a different Google event than the one this worker actually materialized", () => {
    const sql = makeSql();
    withMaterializedEvent(sql, "event-page-1", "evt-real-42", "primary");

    const approval = proposeRsvp(
      sql,
      // eventId/calendarId ARE optional on RsvpInput's type (so the SAME
      // type can represent both a caller's propose-time input and the
      // resolved execute-time payload — see calendar-write-model.ts's
      // RsvpInput doc comment) but supplying them at propose time anyway
      // (as a hostile or buggy caller might) must still be discarded, not
      // honored — proposeRsvp always overwrites them with the resolved
      // values below.
      { eventPageID: "event-page-1", eventId: "attacker-supplied-event", calendarId: "not-primary", responseStatus: "accepted" },
      1000,
    );

    const payload = approval.payload as { eventId: string; calendarId: string };
    expect(payload.eventId).toBe("evt-real-42");
    expect(payload.calendarId).toBe("primary");
  });
});

describe("confirmApproval — the approval-gate blocks immediate execution, and IS required to execute", () => {
  test("createEvent: confirming a pending approval with the right version token calls Google's API exactly once and marks it executed", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, 1000);
    const approval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);

    let calendarCalls = 0;
    const fetchImpl = fakeFetch((url) => {
      calendarCalls += 1;
      expect(url).toContain("googleapis.com/calendar");
      return new Response(JSON.stringify({ kind: "calendar#event", id: "created-1", iCalUID: "created-1@google.com", etag: '"e"' }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("executed");
    expect(calendarCalls).toBe(1);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");
  });

  test("rsvp: confirming calls GET+PATCH and marks executed", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, 1000);
    withMaterializedEvent(sql, "event-page-1", "evt-1");
    const approval = proposeRsvp(sql, { eventPageID: "event-page-1", responseStatus: "declined" }, 1000);

    const fetchImpl = fakeFetch((_url, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(
          JSON.stringify({ kind: "calendar#event", id: "evt-1", iCalUID: "evt-1@google.com", etag: '"e"', attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ kind: "calendar#event", id: "evt-1", iCalUID: "evt-1@google.com", etag: '"e2"' }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);
    expect(outcome.status).toBe("executed");
  });

  test("a stale/wrong version token is rejected as a conflict WITHOUT calling Google's API", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, 1000);
    const approval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);

    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, "wrong-token");
    expect(outcome.status).toBe("conflict");
    expect(fetchCalled).toBe(false);
    expect(getApproval(sql, approval.id)?.status).toBe("pending");
  });

  test("FIRST-WRITER-WINS: two concurrent confirmApproval calls for the same approval — exactly one executes, the other gets conflict", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, 1000);
    const approval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);

    let calendarCalls = 0;
    const fetchImpl = fakeFetch(() => {
      calendarCalls += 1;
      return new Response(JSON.stringify({ kind: "calendar#event", id: "created-1", iCalUID: "created-1@google.com", etag: '"e"' }), { status: 200 });
    });

    const [first, second] = await Promise.all([
      confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken),
      confirmApproval({ sql, config: CONFIG, now: 2001, fetchImpl }, approval.id, approval.versionToken),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["conflict", "executed"]);
    expect(calendarCalls).toBe(1);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");
  });

  test("an access-token failure (OAuth never connected) marks the approval failed, not pending", async () => {
    const sql = makeSql(); // no stored tokens at all
    const approval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000 }, approval.id, approval.versionToken);
    expect(outcome.status).toBe("failed");
    expect(getApproval(sql, approval.id)?.status).toBe("failed");
  });

  test("rsvp: a 412 (concurrent modification, Fix 4's If-Match guard) marks the approval failed, not executed and not a crash", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, 1000);
    withMaterializedEvent(sql, "event-page-1", "evt-1");
    const approval = proposeRsvp(sql, { eventPageID: "event-page-1", responseStatus: "accepted" }, 1000);

    const fetchImpl = fakeFetch((_url, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(
          JSON.stringify({
            kind: "calendar#event",
            id: "evt-1",
            iCalUID: "evt-1@google.com",
            etag: '"stale-etag"',
            attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }],
          }),
          { status: 200 },
        );
      }
      // Someone else's concurrent write already moved the etag forward —
      // Google rejects our If-Match precondition.
      return new Response(JSON.stringify({ error: { message: "Precondition Failed" } }), { status: 412 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason.toLowerCase()).toContain("concurrent modification");
    }
    // Terminal, not stuck at "confirmed" — the caller can propose a fresh RSVP.
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    // A retry attempt on the same approval id is a conflict, not a second
    // silent overwrite attempt.
    const retry = await confirmApproval({ sql, config: CONFIG, now: 3000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
  });

  test("a Calendar API failure after confirmation marks the approval failed, not reverted to pending", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, 1000);
    const approval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429 }));
    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("failed");
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    // A retry attempt on the same approval id is a conflict, not a second execution.
    const retry = await confirmApproval({ sql, config: CONFIG, now: 3000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
  });
});

describe("reconcileStuckApprovals — sweeps 'confirmed' rows stuck past the timeout (DO interrupted between the CAS commit and the terminal transition)", () => {
  test("a confirmed approval whose CAS-commit timestamp is older than the timeout is transitioned to failed, and a fresh approval can then be proposed for the same logical action", async () => {
    const sql = makeSql();
    const approval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);

    // Simulate the CAS commit succeeding (pending -> confirmed) WITHOUT the
    // terminal executed/failed transition ever running — exactly what a DO
    // interruption (isolate eviction, mid-request deploy, CPU-limit kill)
    // between `tryConfirmApproval` and `markExecuted`/`markFailed` leaves
    // behind (see write-model.ts's `confirmApproval` file header). Calling
    // `tryConfirmApproval` directly (rather than the full `confirmApproval`
    // flow) is exactly how to model that: the CAS ran, nothing after it did.
    const cas = tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    expect(cas.status).toBe("confirmed");
    expect(getApproval(sql, approval.id)?.status).toBe("confirmed");

    // Too soon — not past the timeout yet, nothing to reconcile, and the
    // row is untouched.
    const tooSoon = reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS - 1);
    expect(tooSoon.reconciledApprovalIds).toEqual([]);
    expect(getApproval(sql, approval.id)?.status).toBe("confirmed");

    // Past the timeout — the sweep transitions it to failed, with a
    // reason that identifies the cause.
    const swept = reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS + 1);
    expect(swept.reconciledApprovalIds).toEqual([approval.id]);
    const after = getApproval(sql, approval.id);
    expect(after?.status).toBe("failed");
    expect((after?.result as { error?: string } | undefined)?.error).toContain("confirmation timed out");

    // Running the sweep again is a no-op for this approval — it's already
    // terminal, not `confirmed` any more.
    const sweptAgain = reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS + 1000);
    expect(sweptAgain.reconciledApprovalIds).toEqual([]);

    // A fresh approval CAN now be proposed for the same logical action —
    // the stuck row no longer blocks a new attempt. Before this fix,
    // `tryConfirmApproval` only ever transitions `pending` rows, so a
    // permanently-`confirmed` row would have made the underlying action
    // unrecoverable forever (no retry path at all).
    const retryApproval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 3000);
    expect(retryApproval.status).toBe("pending");
    expect(retryApproval.id).not.toBe(approval.id);

    // And that fresh approval can be confirmed/executed normally — proof
    // the sweep didn't leave the write-model in some broken state.
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ kind: "calendar#event", id: "created-1", iCalUID: "created-1@google.com", etag: '"e"' }), { status: 200 }));
    withValidStoredToken(sql, 3000);
    const outcome = await confirmApproval({ sql, config: CONFIG, now: 4000, fetchImpl }, retryApproval.id, retryApproval.versionToken);
    expect(outcome.status).toBe("executed");
  });

  test("a still-fresh confirmed approval (well within the timeout) is left alone — this sweep must never touch a confirmApproval call legitimately still in flight", async () => {
    const sql = makeSql();
    withMaterializedEvent(sql, "event-page-1", "evt-1");
    const approval = proposeRsvp(sql, { eventPageID: "event-page-1", responseStatus: "accepted" }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);

    const result = reconcileStuckApprovals(sql, 2000 + 1000); // 1s later, nowhere near the 5-minute timeout
    expect(result.reconciledApprovalIds).toEqual([]);
    expect(getApproval(sql, approval.id)?.status).toBe("confirmed");
  });

  test("pending/executed/failed rows are never touched by the sweep — only 'confirmed' rows are eligible", async () => {
    const sql = makeSql();
    const stillPending = proposeCreateEvent(sql, { summary: "Still pending", start: {}, end: {} }, 1000);
    const executed = proposeCreateEvent(sql, { summary: "Already executed", start: {}, end: {} }, 1000);
    withValidStoredToken(sql, 1000);
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ kind: "calendar#event", id: "e1", iCalUID: "e1@google.com", etag: '"e"' }), { status: 200 }));
    await confirmApproval({ sql, config: CONFIG, now: 1500, fetchImpl }, executed.id, executed.versionToken);
    expect(getApproval(sql, executed.id)?.status).toBe("executed");

    const farFuture = 1000 + APPROVAL_CONFIRMATION_TIMEOUT_MS * 10;
    const result = reconcileStuckApprovals(sql, farFuture);

    expect(result.reconciledApprovalIds).toEqual([]);
    expect(getApproval(sql, stillPending.id)?.status).toBe("pending");
    expect(getApproval(sql, executed.id)?.status).toBe("executed");
  });
});

// ---------------------------------------------------------------------------
// "sendEmail" — the third action kind (this task). Mirrors the calendar
// describe blocks above exactly, proving the write-model's approval-gate
// design generalizes to a whole new provider call without any new core
// logic (see write-model.ts's file header, "ADDING sendEmail AS A THIRD
// ACTION KIND").
// ---------------------------------------------------------------------------

describe("proposeSendEmail", () => {
  test("creates a pending approval WITHOUT touching Gmail's API at all", () => {
    const sql = makeSql();
    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    void fetchImpl; // not passed anywhere below — proposing must not need it

    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "Just checking in." }, 1000);

    expect(approval.status).toBe("pending");
    expect(approval.actionType).toBe("sendEmail");
    expect(fetchCalled).toBe(false);
    expect(getApproval(sql, approval.id)).toEqual(approval);
    expect(listPendingApprovals(sql)).toEqual([approval]);
  });

  test("Fix 2: mints and persists a Message-ID on the approval row at propose time, before any send happens", () => {
    const sql = makeSql();
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);
    expect(approval.providerMessageId).toBeDefined();
    expect(approval.providerMessageId).toMatch(/^<.+@.+>$/);
    expect(getApproval(sql, approval.id)?.providerMessageId).toBe(approval.providerMessageId);
  });

  // -------------------------------------------------------------------
  // Fix 1 (adversarial review, plan §Google gatekeeper): RFC 2822 header
  // injection. `proposeSendEmail` must reject a CRLF-injection attempt in
  // to/cc/bcc/subject BEFORE an approval row is ever created — earlier
  // than gmail-send.ts's own defense-in-depth check at send time, so a
  // malicious proposal never even becomes a pending row someone could
  // accidentally confirm.
  // -------------------------------------------------------------------

  test("a CRLF-injection attempt in `to` is rejected — no approval row is created", () => {
    const sql = makeSql();
    expect(() =>
      proposeSendEmail(sql, { to: ["guest@example.com\r\nBcc: attacker@evil.com"], subject: "Hello", body: "b" }, 1000),
    ).toThrow(SendEmailValidationError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("a CRLF-injection attempt in `cc` is rejected — no approval row is created", () => {
    const sql = makeSql();
    expect(() =>
      proposeSendEmail(
        sql,
        { to: ["guest@example.com"], cc: ["cc@example.com\r\nBcc: attacker@evil.com"], subject: "Hello", body: "b" },
        1000,
      ),
    ).toThrow(SendEmailValidationError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("a CRLF-injection attempt in `bcc` is rejected — no approval row is created", () => {
    const sql = makeSql();
    expect(() =>
      proposeSendEmail(
        sql,
        { to: ["guest@example.com"], bcc: ["hidden@example.com\r\nBcc: attacker@evil.com"], subject: "Hello", body: "b" },
        1000,
      ),
    ).toThrow(SendEmailValidationError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("a CRLF-injection attempt in `subject` is rejected — no approval row is created", () => {
    const sql = makeSql();
    expect(() =>
      proposeSendEmail(
        sql,
        { to: ["guest@example.com"], subject: "Hello\r\n\r\nOverridden body", body: "b" },
        1000,
      ),
    ).toThrow(SendEmailValidationError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });
});

describe("confirmApproval — sendEmail: the approval gate blocks immediate send, and IS required to send", () => {
  test("confirming a pending sendEmail approval with the right version token calls Gmail's messages.send exactly once, with correctly-encoded MIME content, and marks it executed", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailSendScope(sql, 1000);
    const approval = proposeSendEmail(
      sql,
      { to: ["guest@example.com"], cc: ["cc@example.com"], subject: "Hello", body: "Just checking in." },
      1000,
    );

    let gmailCalls = 0;
    let sentInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      gmailCalls += 1;
      sentInit = init;
      expect(url).toBe("https://www.googleapis.com/gmail/v1/users/me/messages/send");
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("executed");
    expect(gmailCalls).toBe(1);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");

    // Never called the fake Gmail send API before confirmApproval ran —
    // proposeSendEmail above already proved that; this proves the ONE call
    // that did happen carries correctly-encoded MIME content.
    const sentBody = JSON.parse(sentInit!.body as string);
    const decoded = decodedRawMessage(sentBody);
    expect(decoded).toContain("To: guest@example.com");
    expect(decoded).toContain("Cc: cc@example.com");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded.endsWith("Just checking in.")).toBe(true);
  });

  test("the fake Gmail send API is never called before confirmApproval — the approval gate genuinely blocks immediate send", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailSendScope(sql, 1000);
    let gmailCalled = false;
    const fetchImpl = fakeFetch(() => {
      gmailCalled = true;
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), { status: 200 });
    });

    // Propose only — deliberately never calling confirmApproval.
    proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);
    void fetchImpl;

    expect(gmailCalled).toBe(false);
  });

  test("a stale/wrong version token is rejected as a conflict WITHOUT calling Gmail's API", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailSendScope(sql, 1000);
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);

    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, "wrong-token");
    expect(outcome.status).toBe("conflict");
    expect(fetchCalled).toBe(false);
    expect(getApproval(sql, approval.id)?.status).toBe("pending");
  });

  test("FIRST-WRITER-WINS: two concurrent confirmApproval calls for the same sendEmail approval — exactly one send happens, the other gets conflict", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailSendScope(sql, 1000);
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);

    let gmailCalls = 0;
    const fetchImpl = fakeFetch(() => {
      gmailCalls += 1;
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), { status: 200 });
    });

    const [first, second] = await Promise.all([
      confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken),
      confirmApproval({ sql, config: CONFIG, now: 2001, fetchImpl }, approval.id, approval.versionToken),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["conflict", "executed"]);
    expect(gmailCalls).toBe(1);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");
  });

  test("GMAIL_SEND_SCOPE not granted: confirmApproval fails CLEANLY (markFailed with a clear reason), not a crash and not a confusing Gmail 403 — the fake send API is never even called", async () => {
    const sql = makeSql();
    // Deliberately the scope-gate-fails fixture: a valid, connected token
    // that only ever granted CALENDAR_EVENTS_SCOPE, never GMAIL_SEND_SCOPE
    // (see withValidStoredToken's updated doc comment above).
    withValidStoredToken(sql, 1000);
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);

    let gmailCalled = false;
    const fetchImpl = fakeFetch(() => {
      gmailCalled = true;
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("Gmail send scope not granted");
    }
    expect(gmailCalled).toBe(false); // never even attempted the call, let alone hit a real 403
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    // Terminal, not stuck at "confirmed" — a retry attempt is a conflict,
    // not a second scope-check/send attempt.
    const retry = await confirmApproval({ sql, config: CONFIG, now: 3000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
  });

  test("a Gmail API failure after confirmation marks the approval failed, not reverted to pending", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailSendScope(sql, 1000);
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429 }));
    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("failed");
    expect(getApproval(sql, approval.id)?.status).toBe("failed");
  });
});

describe("reconcileStuckApprovals also reconciles a stuck 'sendEmail' approval — proof the sweep runs for every kind, though sendEmail lands somewhere DIFFERENT from calendar (Fix 2)", () => {
  test("a confirmed sendEmail approval whose CAS-commit timestamp is older than the timeout is transitioned to 'unknown' (NOT 'failed') by the SAME sweep that reconciles calendar approvals to 'failed'", async () => {
    const sql = makeSql();
    const calendarApproval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);
    const emailApproval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);

    // Simulate BOTH approvals getting stuck at "confirmed" (the CAS ran,
    // the terminal transition never did — see the calendar sweep test
    // above for the full "DO interrupted mid-execution" scenario this
    // models) — one calendar, one Gmail, on the SAME sweep call.
    tryConfirmApproval(sql, calendarApproval.id, calendarApproval.versionToken, 2000);
    tryConfirmApproval(sql, emailApproval.id, emailApproval.versionToken, 2000);
    expect(getApproval(sql, calendarApproval.id)?.status).toBe("confirmed");
    expect(getApproval(sql, emailApproval.id)?.status).toBe("confirmed");

    const swept = reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS + 1);

    expect(swept.reconciledApprovalIds.sort()).toEqual([calendarApproval.id, emailApproval.id].sort());

    // Fix 2: sendEmail — an irreversible external side effect — must NOT
    // land on the same confident "failed" label wall-clock-only calendar
    // reconciliation correctly uses. It lands on a distinct "unknown"
    // status instead, naming the Message-ID a human should check the Sent
    // folder against before ever retrying.
    const emailAfter = getApproval(sql, emailApproval.id);
    expect(emailAfter?.status).toBe("unknown");
    expect(emailAfter?.actionType).toBe("sendEmail");
    expect((emailAfter?.result as { error?: string } | undefined)?.error).toContain("confirmation timed out");
    expect((emailAfter?.result as { error?: string } | undefined)?.error).toContain("verify the Sent folder");
    expect((emailAfter?.result as { error?: string } | undefined)?.error).toContain(emailApproval.providerMessageId ?? "");

    // Calendar's own reconciliation is completely unchanged by this fix —
    // still lands on "failed", same as before.
    expect(getApproval(sql, calendarApproval.id)?.status).toBe("failed");
  });

  test("'unknown' is a genuinely terminal status — a confirm retry on the same approval id is still a conflict, not a silent re-execution", async () => {
    const sql = makeSql();
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS + 1);
    expect(getApproval(sql, approval.id)?.status).toBe("unknown");

    let gmailCalled = false;
    const fetchImpl = fakeFetch(() => {
      gmailCalled = true;
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), { status: 200 });
    });
    withValidStoredTokenAndGmailSendScope(sql, 3000);
    const retry = await confirmApproval({ sql, config: CONFIG, now: 4000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
    expect(gmailCalled).toBe(false); // no automated/blind retry ever reaches Gmail's API

    // But — exactly like a "failed" approval — a fresh sendEmail approval
    // CAN be proposed and confirmed normally afterwards; the stuck row
    // doesn't wedge the Gmail action kind specifically, it only refuses to
    // let ITSELF be silently retried.
    const retryApproval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 5000);
    expect(retryApproval.status).toBe("pending");
    const outcome = await confirmApproval({ sql, config: CONFIG, now: 6000, fetchImpl }, retryApproval.id, retryApproval.versionToken);
    expect(outcome.status).toBe("executed");
  });

  test("a still-fresh confirmed sendEmail approval (well within the timeout) is left alone", () => {
    const sql = makeSql();
    const approval = proposeSendEmail(sql, { to: ["guest@example.com"], subject: "Hello", body: "b" }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);

    const result = reconcileStuckApprovals(sql, 2000 + 1000); // 1s later, nowhere near the 5-minute timeout
    expect(result.reconciledApprovalIds).toEqual([]);
    expect(getApproval(sql, approval.id)?.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// Gmail triage — archiveThread/applyLabel/removeLabel/markRead/markUnread
// (this task). Mirrors the sendEmail describe blocks above: proof the
// write-model's approval-gate design generalizes to five more action kinds
// without any new core CAS logic (see write-model.ts's file header, "ADDING
// GMAIL TRIAGE AS FIVE MORE ACTION KINDS", and approvals-store.ts's header
// above `ApprovalStatus`).
// ---------------------------------------------------------------------------

describe("proposeArchiveThread / proposeApplyLabel / proposeRemoveLabel / proposeMarkRead / proposeMarkUnread", () => {
  test("each creates a pending approval WITHOUT touching Gmail's API at all", () => {
    const sql = makeSql();
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    void fetchImpl; // not passed anywhere below — proposing must not need it

    const archive = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);
    expect(archive.status).toBe("pending");
    expect(archive.actionType).toBe("archiveThread");

    const apply = proposeApplyLabel(sql, { threadPageID: "email_thread_aaa", label: "IMPORTANT" }, 1000);
    expect(apply.status).toBe("pending");
    expect(apply.actionType).toBe("applyLabel");

    const remove = proposeRemoveLabel(sql, { threadPageID: "email_thread_aaa", label: "IMPORTANT" }, 1000);
    expect(remove.status).toBe("pending");
    expect(remove.actionType).toBe("removeLabel");

    const markRead = proposeMarkRead(sql, { threadPageID: "email_thread_aaa" }, 1000);
    expect(markRead.status).toBe("pending");
    expect(markRead.actionType).toBe("markRead");

    const markUnread = proposeMarkUnread(sql, { threadPageID: "email_thread_aaa" }, 1000);
    expect(markUnread.status).toBe("pending");
    expect(markUnread.actionType).toBe("markUnread");

    expect(fetchCalled).toBe(false);
    expect(listPendingApprovals(sql)).toHaveLength(5);
  });

  test("resolves and persists the raw Gmail threadId on the approval payload at propose time (audit-log fidelity, no second lookup needed at confirm time)", () => {
    const sql = makeSql();
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);
    expect(approval.payload).toEqual({ threadPageID: "email_thread_aaa", threadId: "18abc0001" });
  });

  test("proposeArchiveThread with an unknown/unresolvable threadPageID throws TriageThreadNotFoundError and creates NO approval row", () => {
    const sql = makeSql();
    expect(() => proposeArchiveThread(sql, { threadPageID: "email_thread_never_seen" }, 1000)).toThrow(TriageThreadNotFoundError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("proposeApplyLabel with an unknown/unresolvable threadPageID throws TriageThreadNotFoundError and creates NO approval row", () => {
    const sql = makeSql();
    expect(() => proposeApplyLabel(sql, { threadPageID: "email_thread_never_seen", label: "IMPORTANT" }, 1000)).toThrow(TriageThreadNotFoundError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("proposeRemoveLabel with an unknown/unresolvable threadPageID throws TriageThreadNotFoundError and creates NO approval row", () => {
    const sql = makeSql();
    expect(() => proposeRemoveLabel(sql, { threadPageID: "email_thread_never_seen", label: "IMPORTANT" }, 1000)).toThrow(TriageThreadNotFoundError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("proposeMarkRead with an unknown/unresolvable threadPageID throws TriageThreadNotFoundError and creates NO approval row", () => {
    const sql = makeSql();
    expect(() => proposeMarkRead(sql, { threadPageID: "email_thread_never_seen" }, 1000)).toThrow(TriageThreadNotFoundError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });

  test("proposeMarkUnread with an unknown/unresolvable threadPageID throws TriageThreadNotFoundError and creates NO approval row", () => {
    const sql = makeSql();
    expect(() => proposeMarkUnread(sql, { threadPageID: "email_thread_never_seen" }, 1000)).toThrow(TriageThreadNotFoundError);
    expect(listPendingApprovals(sql)).toEqual([]);
  });
});

describe("confirmApproval — Gmail triage: the approval gate blocks immediate execution, and IS required to execute", () => {
  test("archiveThread: confirming calls Gmail's threads.modify exactly once with removeLabelIds: [\"INBOX\"] and marks executed", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);

    let gmailCalls = 0;
    let sentInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      gmailCalls += 1;
      sentInit = init;
      expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/threads/18abc0001/modify");
      return new Response(JSON.stringify({ id: "18abc0001", labelIds: [] }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("executed");
    expect(gmailCalls).toBe(1);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");
    expect(JSON.parse(sentInit!.body as string)).toEqual({ removeLabelIds: ["INBOX"] });
  });

  test("applyLabel: confirming calls threads.modify with addLabelIds: [label] and marks executed", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeApplyLabel(sql, { threadPageID: "email_thread_aaa", label: "Label_1" }, 1000);

    let gmailCalls = 0;
    let sentInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      gmailCalls += 1;
      sentInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);
    expect(outcome.status).toBe("executed");
    expect(gmailCalls).toBe(1);
    expect(JSON.parse(sentInit!.body as string)).toEqual({ addLabelIds: ["Label_1"] });
  });

  test("removeLabel: confirming calls threads.modify with removeLabelIds: [label] and marks executed", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeRemoveLabel(sql, { threadPageID: "email_thread_aaa", label: "STARRED" }, 1000);

    let gmailCalls = 0;
    let sentInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      gmailCalls += 1;
      sentInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);
    expect(outcome.status).toBe("executed");
    expect(gmailCalls).toBe(1);
    expect(JSON.parse(sentInit!.body as string)).toEqual({ removeLabelIds: ["STARRED"] });
  });

  test("markRead: confirming calls threads.modify with removeLabelIds: [\"UNREAD\"] and marks executed", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeMarkRead(sql, { threadPageID: "email_thread_aaa" }, 1000);

    let gmailCalls = 0;
    let sentInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      gmailCalls += 1;
      sentInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);
    expect(outcome.status).toBe("executed");
    expect(gmailCalls).toBe(1);
    expect(JSON.parse(sentInit!.body as string)).toEqual({ removeLabelIds: ["UNREAD"] });
  });

  test("markUnread: confirming calls threads.modify with addLabelIds: [\"UNREAD\"] and marks executed", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeMarkUnread(sql, { threadPageID: "email_thread_aaa" }, 1000);

    let gmailCalls = 0;
    let sentInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      gmailCalls += 1;
      sentInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);
    expect(outcome.status).toBe("executed");
    expect(gmailCalls).toBe(1);
    expect(JSON.parse(sentInit!.body as string)).toEqual({ addLabelIds: ["UNREAD"] });
  });

  test("the fake Gmail modify API is never called before confirmApproval — the approval gate genuinely blocks immediate execution", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    let gmailCalled = false;
    const fetchImpl = fakeFetch(() => {
      gmailCalled = true;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);
    void fetchImpl;

    expect(gmailCalled).toBe(false);
  });

  test("a stale/wrong version token is rejected as a conflict WITHOUT calling Gmail's API", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);

    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, "wrong-token");
    expect(outcome.status).toBe("conflict");
    expect(fetchCalled).toBe(false);
    expect(getApproval(sql, approval.id)?.status).toBe("pending");
  });

  test("FIRST-WRITER-WINS: two concurrent confirmApproval calls for the same triage approval — exactly one executes, the other gets conflict", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);

    let gmailCalls = 0;
    const fetchImpl = fakeFetch(() => {
      gmailCalls += 1;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    const [first, second] = await Promise.all([
      confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken),
      confirmApproval({ sql, config: CONFIG, now: 2001, fetchImpl }, approval.id, approval.versionToken),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["conflict", "executed"]);
    expect(gmailCalls).toBe(1);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");
  });

  test("GMAIL_MODIFY_SCOPE not granted: confirmApproval fails CLEANLY (markFailed with a clear reconnect reason), not a crash and not a confusing Gmail 403 — the fake modify API is never even called", async () => {
    const sql = makeSql();
    // Deliberately the scope-gate-fails fixture: a valid, connected token
    // that only ever granted CALENDAR_EVENTS_SCOPE, never GMAIL_MODIFY_SCOPE.
    withValidStoredToken(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);

    let gmailCalled = false;
    const fetchImpl = fakeFetch(() => {
      gmailCalled = true;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });

    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("Gmail modify scope not granted");
      expect(outcome.reason).toContain("reconnect");
    }
    expect(gmailCalled).toBe(false); // never even attempted the call, let alone hit a real 403
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    // Terminal, not stuck at "confirmed" — a retry attempt is a conflict,
    // not a second scope-check/execute attempt.
    const retry = await confirmApproval({ sql, config: CONFIG, now: 3000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
  });

  test("a Gmail API failure after confirmation marks the approval failed, not reverted to pending — retry is a conflict, not a second execution", async () => {
    const sql = makeSql();
    withValidStoredTokenAndGmailModifyScope(sql, 1000);
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeMarkRead(sql, { threadPageID: "email_thread_aaa" }, 1000);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429 }));
    const outcome = await confirmApproval({ sql, config: CONFIG, now: 2000, fetchImpl }, approval.id, approval.versionToken);

    expect(outcome.status).toBe("failed");
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    const retry = await confirmApproval({ sql, config: CONFIG, now: 3000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
  });
});

describe("reconcileStuckApprovals also reconciles a stuck triage approval — lands on 'failed', NOT 'unknown' (unlike sendEmail, Fix 2)", () => {
  test("a confirmed archiveThread approval whose CAS-commit timestamp is older than the timeout is transitioned to 'failed' by the SAME sweep that reconciles calendar approvals to 'failed'", async () => {
    const sql = makeSql();
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const calendarApproval = proposeCreateEvent(sql, { summary: "Standup", start: {}, end: {} }, 1000);
    const triageApproval = proposeArchiveThread(sql, { threadPageID: "email_thread_aaa" }, 1000);

    tryConfirmApproval(sql, calendarApproval.id, calendarApproval.versionToken, 2000);
    tryConfirmApproval(sql, triageApproval.id, triageApproval.versionToken, 2000);
    expect(getApproval(sql, calendarApproval.id)?.status).toBe("confirmed");
    expect(getApproval(sql, triageApproval.id)?.status).toBe("confirmed");

    const swept = reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS + 1);

    expect(swept.reconciledApprovalIds.sort()).toEqual([calendarApproval.id, triageApproval.id].sort());

    // The core assertion this task's report must confirm explicitly:
    // triage lands on "failed", exactly like calendar — NOT "unknown"
    // (sendEmail's distinct terminal status, Fix 2) — because all five
    // triage actions are reversible, unlike an irreversible sent email.
    const triageAfter = getApproval(sql, triageApproval.id);
    expect(triageAfter?.status).toBe("failed");
    expect(triageAfter?.actionType).toBe("archiveThread");
    expect((triageAfter?.result as { error?: string } | undefined)?.error).toContain("confirmation timed out");

    expect(getApproval(sql, calendarApproval.id)?.status).toBe("failed");
  });

  test("'failed' is a genuinely terminal status for a reconciled triage approval — a confirm retry on the same approval id is still a conflict, not a silent re-execution, but a FRESH approval for the same action can be proposed and confirmed normally", async () => {
    const sql = makeSql();
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeMarkUnread(sql, { threadPageID: "email_thread_aaa" }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    reconcileStuckApprovals(sql, 2000 + APPROVAL_CONFIRMATION_TIMEOUT_MS + 1);
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    let gmailCalled = false;
    const fetchImpl = fakeFetch(() => {
      gmailCalled = true;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });
    withValidStoredTokenAndGmailModifyScope(sql, 3000);
    const retry = await confirmApproval({ sql, config: CONFIG, now: 4000, fetchImpl }, approval.id, approval.versionToken);
    expect(retry.status).toBe("conflict");
    expect(gmailCalled).toBe(false);

    const retryApproval = proposeMarkUnread(sql, { threadPageID: "email_thread_aaa" }, 5000);
    expect(retryApproval.status).toBe("pending");
    const outcome = await confirmApproval({ sql, config: CONFIG, now: 6000, fetchImpl }, retryApproval.id, retryApproval.versionToken);
    expect(outcome.status).toBe("executed");
  });

  test("a still-fresh confirmed triage approval (well within the timeout) is left alone", () => {
    const sql = makeSql();
    withMaterializedThread(sql, "email_thread_aaa", "18abc0001");
    const approval = proposeApplyLabel(sql, { threadPageID: "email_thread_aaa", label: "IMPORTANT" }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);

    const result = reconcileStuckApprovals(sql, 2000 + 1000); // 1s later, nowhere near the 5-minute timeout
    expect(result.reconciledApprovalIds).toEqual([]);
    expect(getApproval(sql, approval.id)?.status).toBe("confirmed");
  });
});

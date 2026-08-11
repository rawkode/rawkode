// gatekeeper-google-write-routes.test.ts — real Access-JWT round-trip
// tests for `handleGatekeeperGoogleWriteRequest` (./gatekeeper-google-
// write-routes.ts), mirroring `access-auth.test.ts`'s testing style
// exactly (a real RSA keypair, a real signed JWT, served through a FAKE
// JWKS HTTP response via `verifyAccessRequest`'s own test-only
// `VerifyAccessOptions` escape hatch) — no step here mocks "always
// succeeds" auth; the same `verifyAccessRequest` code path production
// requests go through is exercised for real, just pointed at a fake JWKS
// server. The Service Binding RPC calls themselves are faked with plain
// structural stub objects (matching `Fetcher`'s real shape only in the
// method names/signatures this module calls — see
// `./gatekeeper-google-write-routes.ts`'s own `CalendarWriteModelStub`/
// `GmailWriteModelStub`), since a real named-entrypoint Service Binding
// needs a live Workers runtime this test suite doesn't have (same
// "structural stub, not a live binding" caveat `./graphql/composed-
// schema.test.ts` documents for `GATEKEEPER_GOOGLE`'s read direction).

import { describe, expect, test } from "bun:test";
import { exportJWK, type FetchImplementation, generateKeyPair, SignJWT } from "jose";
import { handleGatekeeperGoogleWriteRequest } from "./gatekeeper-google-write-routes";

const HEADER_NAME = "Cf-Access-Jwt-Assertion";
const TEST_AUD = "test-access-application-aud-tag";

let domainCounter = 0;
/** A fresh, never-reused team domain per test — same JWKS-cache-isolation
 *  reasoning as `access-auth.test.ts`'s `uniqueDomain`. */
function uniqueDomain(): string {
  domainCounter += 1;
  return `write-routes-test-${domainCounter}-${Date.now()}.cloudflareaccess.com`;
}

interface SignedTestToken {
  token: string;
  fetchImpl: FetchImplementation;
}

/** Verbatim copy of `access-auth.test.ts`'s `signTestToken` helper (kept
 *  local rather than exported/shared — these are two independently
 *  reviewed test files, matching this codebase's established
 *  "duplicated test fixtures over a shared test-only module" posture, see
 *  e.g. `gmail-ingest-failures-store.ts`'s file header on duplicating
 *  `ingest-failures-store.ts`'s argument rather than generalizing it). */
async function signTestToken(teamDomain: string): Promise<SignedTestToken> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "test-key-1";
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  const token = await new SignJWT({ email: "device@example.com" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(`https://${teamDomain}`)
    .setAudience(TEST_AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const fetchImpl: FetchImplementation = async (url) => {
    if (url !== certsUrl) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { token, fetchImpl };
}

interface FakeEnvOptions {
  calendar?: Partial<{
    createEvent: (input: unknown) => Promise<unknown>;
    rsvp: (input: unknown) => Promise<unknown>;
  }>;
  gmail?: Partial<{
    archiveThread: (input: unknown) => Promise<unknown>;
    applyLabel: (input: unknown) => Promise<unknown>;
    removeLabel: (input: unknown) => Promise<unknown>;
    markRead: (input: unknown) => Promise<unknown>;
    markUnread: (input: unknown) => Promise<unknown>;
    sendEmail: (input: unknown) => Promise<unknown>;
  }>;
}

function notCalled(name: string) {
  return async () => {
    throw new Error(`${name} should not have been called in this test`);
  };
}

/** Builds a fake `GatekeeperGoogleWriteEnv` — the two Service Binding
 *  fetchers are plain objects exposing exactly the RPC methods
 *  `handleGatekeeperGoogleWriteRequest` calls, cast to `Fetcher` the same
 *  way `./gatekeeper-google-write-routes.ts`'s own `asCalendarWriteModelStub`/
 *  `asGmailWriteModelStub` cast a real one — a real named-entrypoint
 *  Service Binding dispatches by method name/arity over the wire, not by
 *  the caller's static TypeScript type, so this is a faithful stand-in for
 *  what this module actually calls. */
function fakeEnv(teamDomain: string, options: FakeEnvOptions = {}) {
  const calendar = {
    createEvent: options.calendar?.createEvent ?? notCalled("createEvent"),
    rsvp: options.calendar?.rsvp ?? notCalled("rsvp"),
  };
  const gmail = {
    archiveThread: options.gmail?.archiveThread ?? notCalled("archiveThread"),
    applyLabel: options.gmail?.applyLabel ?? notCalled("applyLabel"),
    removeLabel: options.gmail?.removeLabel ?? notCalled("removeLabel"),
    markRead: options.gmail?.markRead ?? notCalled("markRead"),
    markUnread: options.gmail?.markUnread ?? notCalled("markUnread"),
    sendEmail: options.gmail?.sendEmail ?? notCalled("sendEmail"),
  };
  return {
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: TEST_AUD,
    GATEKEEPER_GOOGLE_CALENDAR_WRITE: calendar as unknown as Fetcher,
    GATEKEEPER_GOOGLE_GMAIL_WRITE: gmail as unknown as Fetcher,
  };
}

function postRequest(path: string, body: unknown, token?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set(HEADER_NAME, token);
  return new Request(`https://vault.example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("handleGatekeeperGoogleWriteRequest — auth gating", () => {
  test("a request with NO Cf-Access-Jwt-Assertion header is rejected 401, and the RPC binding is never called", async () => {
    const teamDomain = uniqueDomain();
    const env = fakeEnv(teamDomain);

    const response = await handleGatekeeperGoogleWriteRequest(
      postRequest("/gatekeeper-google/calendar/create-event", { summary: "x", start: {}, end: {} }),
      env,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain(HEADER_NAME);
  });

  test("a request with an invalid (garbage) Access token is rejected, not forwarded", async () => {
    const teamDomain = uniqueDomain();
    const env = fakeEnv(teamDomain);

    const response = await handleGatekeeperGoogleWriteRequest(
      postRequest("/gatekeeper-google/gmail/send", { to: ["a@example.com"], subject: "x", body: "y" }, "not-a-real-jwt"),
      env,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  test("a validly signed token but for the WRONG Access Application (aud mismatch) is rejected", async () => {
    const teamDomain = uniqueDomain();
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = "test-key-1";
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    const wrongAudToken = await new SignJWT({ email: "device@example.com" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(`https://${teamDomain}`)
      .setAudience("some-other-application-aud")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    const fetchImpl: FetchImplementation = async (url) => {
      if (url !== certsUrl) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const env = fakeEnv(teamDomain);
    const response = await handleGatekeeperGoogleWriteRequest(
      postRequest("/gatekeeper-google/calendar/rsvp", { eventPageID: "p1", responseStatus: "accepted" }, wrongAudToken),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(403);
  });
});

describe("handleGatekeeperGoogleWriteRequest — correct forwarding + response passthrough, once authenticated", () => {
  test("POST /gatekeeper-google/calendar/create-event forwards the parsed body to CalendarWriteModel.createEvent and passes its result through verbatim", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    let seenInput: unknown;
    const pendingApproval = { id: "appr-1", actionType: "createEvent", status: "pending", versionToken: "vt-1", payload: {}, result: null, createdAt: 1, updatedAt: 1 };
    const env = fakeEnv(teamDomain, {
      calendar: {
        createEvent: async (input) => {
          seenInput = input;
          return pendingApproval;
        },
      },
    });

    const input = { summary: "Standup", start: { dateTime: "2026-08-15T09:00:00+01:00" }, end: { dateTime: "2026-08-15T09:15:00+01:00" } };
    const response = await handleGatekeeperGoogleWriteRequest(
      postRequest("/gatekeeper-google/calendar/create-event", input, token),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(200);
    expect(seenInput).toEqual(input);
    const body = (await response.json()) as unknown;
    expect(body).toEqual(pendingApproval);
  });

  test("POST /gatekeeper-google/calendar/rsvp forwards to CalendarWriteModel.rsvp", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    let seenInput: unknown;
    const pendingApproval = { id: "appr-2", actionType: "rsvp", status: "pending", versionToken: "vt-2", payload: {}, result: null, createdAt: 1, updatedAt: 1 };
    const env = fakeEnv(teamDomain, { calendar: { rsvp: async (input) => { seenInput = input; return pendingApproval; } } });

    const input = { eventPageID: "event-page-1", responseStatus: "accepted" as const };
    const response = await handleGatekeeperGoogleWriteRequest(postRequest("/gatekeeper-google/calendar/rsvp", input, token), env, { fetchImpl });

    expect(response.status).toBe(200);
    expect(seenInput).toEqual(input);
    const body = (await response.json()) as unknown;
    expect(body).toEqual(pendingApproval);
  });

  const gmailTriageRoutes: { path: string; method: keyof NonNullable<FakeEnvOptions["gmail"]>; input: unknown }[] = [
    { path: "/gatekeeper-google/gmail/archive-thread", method: "archiveThread", input: { threadPageID: "t1" } },
    { path: "/gatekeeper-google/gmail/apply-label", method: "applyLabel", input: { threadPageID: "t1", label: "IMPORTANT" } },
    { path: "/gatekeeper-google/gmail/remove-label", method: "removeLabel", input: { threadPageID: "t1", label: "IMPORTANT" } },
    { path: "/gatekeeper-google/gmail/mark-read", method: "markRead", input: { threadPageID: "t1" } },
    { path: "/gatekeeper-google/gmail/mark-unread", method: "markUnread", input: { threadPageID: "t1" } },
  ];

  for (const route of gmailTriageRoutes) {
    test(`POST ${route.path} forwards to GmailWriteModel.${route.method}`, async () => {
      const teamDomain = uniqueDomain();
      const { token, fetchImpl } = await signTestToken(teamDomain);

      let seenInput: unknown;
      const pendingApproval = { id: "appr-3", actionType: route.method, status: "pending", versionToken: "vt-3", payload: {}, result: null, createdAt: 1, updatedAt: 1 };
      const env = fakeEnv(teamDomain, {
        gmail: { [route.method]: async (input: unknown) => { seenInput = input; return pendingApproval; } } as FakeEnvOptions["gmail"],
      });

      const response = await handleGatekeeperGoogleWriteRequest(postRequest(route.path, route.input, token), env, { fetchImpl });

      expect(response.status).toBe(200);
      expect(seenInput).toEqual(route.input);
      const body = (await response.json()) as unknown;
      expect(body).toEqual(pendingApproval);
    });
  }

  test("POST /gatekeeper-google/gmail/send forwards to GmailWriteModel.sendEmail", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    let seenInput: unknown;
    const pendingApproval = { id: "appr-4", actionType: "sendEmail", status: "pending", versionToken: "vt-4", payload: {}, result: null, createdAt: 1, updatedAt: 1 };
    const env = fakeEnv(teamDomain, { gmail: { sendEmail: async (input) => { seenInput = input; return pendingApproval; } } });

    const input = { to: ["a@example.com"], subject: "Hello", body: "Hi there" };
    const response = await handleGatekeeperGoogleWriteRequest(postRequest("/gatekeeper-google/gmail/send", input, token), env, { fetchImpl });

    expect(response.status).toBe(200);
    expect(seenInput).toEqual(input);
    const body = (await response.json()) as unknown;
    expect(body).toEqual(pendingApproval);
  });

  test("a thrown RPC error (e.g. RsvpEventNotFoundError) is turned into a 502 carrying the error's message, never an unhandled exception", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);

    const env = fakeEnv(teamDomain, {
      calendar: {
        rsvp: async () => {
          throw new Error('Unknown or unresolvable eventPageID "bogus" — no materialized Calendar event found for it.');
        },
      },
    });

    const response = await handleGatekeeperGoogleWriteRequest(
      postRequest("/gatekeeper-google/calendar/rsvp", { eventPageID: "bogus", responseStatus: "accepted" }, token),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unresolvable eventPageID");
  });

  test("an unknown /gatekeeper-google/* path 404s, once authenticated", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);
    const env = fakeEnv(teamDomain);

    const response = await handleGatekeeperGoogleWriteRequest(postRequest("/gatekeeper-google/nonsense", {}, token), env, { fetchImpl });
    expect(response.status).toBe(404);
  });

  test("a non-POST method is rejected 405, once authenticated", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);
    const env = fakeEnv(teamDomain);

    const headers = new Headers({ [HEADER_NAME]: token });
    const request = new Request("https://vault.example.com/gatekeeper-google/calendar/create-event", { method: "GET", headers });
    const response = await handleGatekeeperGoogleWriteRequest(request, env, { fetchImpl });
    expect(response.status).toBe(405);
  });

  test("an invalid JSON body is rejected 400, once authenticated, and no RPC call is made", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);
    const env = fakeEnv(teamDomain);

    const headers = new Headers({ [HEADER_NAME]: token, "content-type": "application/json" });
    const request = new Request("https://vault.example.com/gatekeeper-google/calendar/create-event", {
      method: "POST",
      headers,
      body: "{not valid json",
    });
    const response = await handleGatekeeperGoogleWriteRequest(request, env, { fetchImpl });
    expect(response.status).toBe(400);
  });

  test("a body that is valid JSON but NOT an object (array/null/string) is rejected 400 — a malformed vault request, not an RPC failure, and no RPC call is made", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);
    const env = fakeEnv(teamDomain);

    for (const badBody of [null, [], "just a string", 42]) {
      const response = await handleGatekeeperGoogleWriteRequest(
        postRequest("/gatekeeper-google/calendar/create-event", badBody, token),
        env,
        { fetchImpl },
      );
      expect(response.status).toBe(400);
    }
  });

  test("a declared Content-Length above the size cap is rejected 413 BEFORE the body is even read, once authenticated", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);
    const env = fakeEnv(teamDomain);

    const headers = new Headers({
      [HEADER_NAME]: token,
      "content-type": "application/json",
      "content-length": String(2 * 1024 * 1024), // 2 MiB, above the 1 MiB cap
    });
    // The body bytes don't actually need to match Content-Length for this
    // test — the cap check reads only the declared header, before ever
    // calling request.json().
    const request = new Request("https://vault.example.com/gatekeeper-google/calendar/create-event", {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "x", start: {}, end: {} }),
    });
    const response = await handleGatekeeperGoogleWriteRequest(request, env, { fetchImpl });
    expect(response.status).toBe(413);
  });

  test("a declared Content-Length at/under the size cap is NOT rejected on size grounds", async () => {
    const teamDomain = uniqueDomain();
    const { token, fetchImpl } = await signTestToken(teamDomain);
    const pendingApproval = { id: "appr-5", actionType: "createEvent", status: "pending", versionToken: "vt-5", payload: {}, result: null, createdAt: 1, updatedAt: 1 };
    const env = fakeEnv(teamDomain, { calendar: { createEvent: async () => pendingApproval } });

    const response = await handleGatekeeperGoogleWriteRequest(
      postRequest("/gatekeeper-google/calendar/create-event", { summary: "x", start: {}, end: {} }, token),
      env,
      { fetchImpl },
    );
    expect(response.status).toBe(200);
  });
});

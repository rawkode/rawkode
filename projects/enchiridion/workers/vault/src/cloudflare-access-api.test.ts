// cloudflare-access-api.test.ts — proves `createCloudflareAccessServiceToken`
// sends the REAL Cloudflare API request shape (method, URL, headers, body)
// documented in ./cloudflare-access-api.ts's header, against a MOCKED
// fetch implementation returning a response matching that same documented
// shape. No live network call — see this file's header comment and the
// task's final report for what remains unverified against a real
// Cloudflare account.

import { describe, expect, test } from "bun:test";
import {
  createCloudflareAccessServiceToken,
  parseCloudflareDurationToMs,
} from "./cloudflare-access-api";

const ENV = { CLOUDFLARE_API_TOKEN: "test-cf-api-token", CLOUDFLARE_ACCOUNT_ID: "test-account-id-123" };

function mockCloudflareSuccess(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: "svc-token-id-1",
          client_id: "abc123.access",
          client_secret: "shh-secret-value",
          name: "enchiridion-test-device",
          duration: "8760h",
          created_at: "2026-08-06T12:00:00Z",
          updated_at: "2026-08-06T12:00:00Z",
          ...overrides,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("createCloudflareAccessServiceToken", () => {
  test("sends the real documented request shape: POST /accounts/{account_id}/access/service_tokens, Bearer auth, {name, duration} body", async () => {
    const { fetchImpl, calls } = mockCloudflareSuccess();

    const result = await createCloudflareAccessServiceToken("enchiridion-test-device", ENV, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-id-123/access/service_tokens",
    );
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-cf-api-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const parsedBody = JSON.parse(call.init.body as string);
    expect(parsedBody).toEqual({ name: "enchiridion-test-device", duration: "8760h" });
  });

  test("maps a successful response into clientId/clientSecret exactly matching the CF-Access-Client-Id/Secret header pair", async () => {
    const { fetchImpl } = mockCloudflareSuccess();
    const result = await createCloudflareAccessServiceToken("enchiridion-test-device", ENV, { fetchImpl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.clientId).toBe("abc123.access");
      expect(result.token.clientSecret).toBe("shh-secret-value");
      expect(result.token.id).toBe("svc-token-id-1");
      expect(result.token.duration).toBe("8760h");
    }
  });

  test("computes expiresAt from created_at + duration", async () => {
    const { fetchImpl } = mockCloudflareSuccess({ created_at: "2026-01-01T00:00:00.000Z", duration: "24h" });
    const result = await createCloudflareAccessServiceToken("enchiridion-test-device", ENV, { fetchImpl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.expiresAt).toBe("2026-01-02T00:00:00.000Z");
    }
  });

  test("respects a caller-supplied duration override in the request body", async () => {
    const { fetchImpl, calls } = mockCloudflareSuccess({ duration: "1h" });
    await createCloudflareAccessServiceToken("enchiridion-test-device", ENV, { fetchImpl, duration: "1h" });

    const parsedBody = JSON.parse(calls[0]!.init.body as string);
    expect(parsedBody.duration).toBe("1h");
  });

  test("returns a 500 result when CLOUDFLARE_API_TOKEN is not configured", async () => {
    const result = await createCloudflareAccessServiceToken("device", { CLOUDFLARE_ACCOUNT_ID: "acc" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("CLOUDFLARE_API_TOKEN");
    }
  });

  test("returns a 500 result when CLOUDFLARE_ACCOUNT_ID is not configured", async () => {
    const result = await createCloudflareAccessServiceToken("device", { CLOUDFLARE_API_TOKEN: "tok" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("CLOUDFLARE_ACCOUNT_ID");
    }
  });

  test("maps a non-success Cloudflare API response (e.g. bad auth) to an error result carrying the real status", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 9109, message: "Invalid access token" }],
          messages: [],
          result: null,
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await createCloudflareAccessServiceToken("device", ENV, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain("Invalid access token");
    }
  });

  test("maps a network-level fetch failure to a 502 error result", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    const result = await createCloudflareAccessServiceToken("device", ENV, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toContain("network unreachable");
    }
  });

  test("errors when Cloudflare's response is missing client_id/client_secret (defensive — should never happen against a real response)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ success: true, result: { id: "x", name: "y" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await createCloudflareAccessServiceToken("device", ENV, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("client_id/client_secret");
    }
  });

  test("errors gracefully on a non-JSON response body", async () => {
    const fetchImpl = (async () => new Response("<html>not json</html>", { status: 502 })) as unknown as typeof fetch;
    const result = await createCloudflareAccessServiceToken("device", ENV, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("non-JSON");
    }
  });
});

describe("parseCloudflareDurationToMs", () => {
  test("parses hours", () => {
    expect(parseCloudflareDurationToMs("8760h")).toBe(8760 * 60 * 60 * 1000);
  });

  test("parses combined hours+minutes", () => {
    expect(parseCloudflareDurationToMs("2h45m")).toBe((2 * 60 + 45) * 60 * 1000);
  });

  test("parses seconds only", () => {
    expect(parseCloudflareDurationToMs("90s")).toBe(90 * 1000);
  });

  test("returns null for 'forever'", () => {
    expect(parseCloudflareDurationToMs("forever")).toBeNull();
  });

  test("returns null for an unparseable string", () => {
    expect(parseCloudflareDurationToMs("not-a-duration")).toBeNull();
  });
});

import { strict as assert } from "node:assert";
import {
	fetchVoiceSession,
	type SessionOutcome,
	type VoiceEnv,
} from "../src/session.ts";
import { type AgentGrant, createDayCapabilities } from "../src/capabilities.ts";
const env: VoiceEnv = {
	WEBSITE_ORIGIN: "https://notes.example",
	ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
	ACCESS_AUDIENCE: "aud",
	ADMIN_EMAILS: "owner@example.com",
	OPENAI_API_KEY: { get: () => Promise.resolve("server-only-key") },
};
const input = {
	sdp: "v=0\r\no=client",
	device: "iphone",
	requestID: "unique-request-123",
};
const request = (body: unknown = input, origin = env.WEBSITE_ORIGIN) =>
	new Request(`${env.WEBSITE_ORIGIN}/api/voice/sessions`, {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
const authenticated = () =>
	Promise.resolve({ ownerId: "access:alice", email: "owner@example.com" });

Deno.test("session broker authenticates and enforces same-origin before spending", async () => {
	let reservations = 0;
	const dependencies = {
		authenticate: () => Promise.resolve(null),
		reserve: () => {
			reservations++;
			return Promise.resolve(null);
		},
	};
	assert.equal(
		(await fetchVoiceSession(request(), env, dependencies)).status,
		401,
	);
	assert.equal(
		(await fetchVoiceSession(
			request(input, "https://evil.example"),
			env,
			dependencies,
		)).status,
		403,
	);
	assert.equal(reservations, 0);
});
Deno.test("session broker fixes provider configuration and returns only transport fields", async () => {
	const outcomes: SessionOutcome[] = [];
	const response = await fetchVoiceSession(request(), env, {
		authenticate: authenticated,
		reserve: (identity, id, device) => {
			assert.equal(identity.ownerId, "access:alice");
			assert.equal(id, input.requestID);
			assert.equal(device, "iphone");
			return Promise.resolve({
				isCurrent: () => Promise.resolve(true),
				record: (value) => {
					outcomes.push(value);
					return Promise.resolve();
				},
			});
		},
		fetch: (_url, options) => {
			assert.equal(_url, "https://api.openai.com/v1/live/sessions");
			assert.equal(options?.redirect, "manual");
			assert.equal(
				new Headers(options?.headers).get("Authorization"),
				"Bearer server-only-key",
			);
			const body = JSON.parse(String(options?.body));
			assert.equal(body.session.model, "gpt-live-1");
			assert.equal(body.session.store, false);
			assert.deepEqual(body.session.delegation, { type: "client" });
			return Promise.resolve(
				Response.json({
					session: { id: "live_123", secret: "never-forward" },
					transport: { sdp: "v=0\r\no=server" },
					apiKey: "never-forward",
				}),
			);
		},
	});
	assert.equal(response.status, 201);
	assert.deepEqual(await response.json(), {
		session: { id: "live_123" },
		transport: { type: "webrtc", sdp: "v=0\r\no=server" },
	});
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(outcomes, [{ state: "created", sessionID: "live_123" }]);
});
Deno.test("request cannot inject owner, model or oversized SDP", async () => {
	let reserved = false;
	for (
		const body of [{ ...input, ownerID: "victim" }, {
			...input,
			model: "other",
		}, { ...input, sdp: "v=0" + "x".repeat(70_000) }]
	) {
		const response = await fetchVoiceSession(request(body), env, {
			authenticate: authenticated,
			reserve: () => {
				reserved = true;
				return Promise.resolve(null);
			},
		});
		assert.equal(response.status, 400);
	}
	assert.equal(reserved, false);
});
Deno.test("provider failure records unknown without leaking payload or retrying", async () => {
	const outcomes: SessionOutcome[] = [];
	let calls = 0;
	const response = await fetchVoiceSession(request(), env, {
		authenticate: authenticated,
		reserve: () =>
			Promise.resolve({
				isCurrent: () => Promise.resolve(true),
				record: (value) => {
					outcomes.push(value);
					return Promise.resolve();
				},
			}),
		fetch: () => {
			calls++;
			return Promise.resolve(new Response("secret detail", { status: 500 }));
		},
	});
	assert.equal(response.status, 502);
	assert.equal(calls, 1);
	assert.ok(!(await response.text()).includes("secret detail"));
	assert.deepEqual(outcomes, [{ state: "unknown" }]);
});
Deno.test("typed day capability binds owner and checks revocation after read", async () => {
	let grant: AgentGrant | null = {
		ownerID: "alice",
		grantID: "grant",
		allowsDayBriefing: true,
		expiresAt: Date.now() + 60_000,
	};
	let reads = 0;
	const capability = createDayCapabilities("alice", "grant", {
		currentGrant: () => Promise.resolve(grant),
		readDay: (ownerID, input) => {
			reads++;
			assert.equal(ownerID, "alice");
			grant = null;
			return Promise.resolve({
				...input,
				fetchedAt: new Date().toISOString(),
				partial: false,
				sources: [],
				events: [],
				github: [],
			});
		},
	});
	await assert.rejects(
		capability.briefing({ date: "2026-09-13", timeZone: "Europe/London" }),
		/Capability unavailable/,
	);
	await assert.rejects(
		capability.briefing({ date: "2026-09-13", timeZone: "Europe/London" }),
		/Capability unavailable/,
	);
	assert.equal(reads, 1);
});
Deno.test("typed day capability rejects invalid dates, foreign identity arguments and call floods", async () => {
	let reads = 0;
	const capability = createDayCapabilities("alice", "grant", {
		currentGrant: () =>
			Promise.resolve({
				ownerID: "alice",
				grantID: "grant",
				expiresAt: Date.now() + 60_000,
				allowsDayBriefing: true,
			}),
		readDay: (_owner, input) => {
			reads++;
			return Promise.resolve({
				...input,
				fetchedAt: new Date().toISOString(),
				partial: true,
				sources: [],
				events: [],
				github: [],
			});
		},
	});
	await assert.rejects(
		capability.briefing({ date: "2026-02-30", timeZone: "UTC" }),
		/Invalid day/,
	);
	await assert.rejects(
		capability.briefing({ date: "2026-09-13", timeZone: "Fake/Zone" }),
		/Invalid time zone/,
	);
	await assert.rejects(
		capability.briefing(
			{ date: "2026-09-13", timeZone: "UTC", ownerID: "victim" } as never,
		),
		/Invalid day/,
	);
	assert.equal(
		(await capability.briefing({ date: "2026-09-13", timeZone: "UTC" }))
			.partial,
		true,
	);
	await assert.rejects(
		capability.briefing({ date: "2026-09-13", timeZone: "UTC" }),
		/budget/,
	);
	assert.equal(reads, 1);
});

Deno.test("briefing strips internal fields from every output level and validates permitted fields", async () => {
	const raw = {
		date: "2026-09-13",
		timeZone: "UTC",
		fetchedAt: "2026-09-13T00:00:00Z",
		partial: false,
		internalCredential: "top-secret",
		sources: [{
			id: "s",
			title: "Source",
			internalCredential: "source-secret",
		}],
		events: [{
			id: "e",
			title: "Meeting",
			start: "2026-09-13T10:00:00Z",
			end: "2026-09-13T11:00:00Z",
			internalCredential: "event-secret",
		}],
		github: [{
			id: "g",
			title: "Pull request",
			action: "opened",
			internalCredential: "github-secret",
		}],
	};
	const capability = createDayCapabilities("alice", "grant", {
		currentGrant: () =>
			Promise.resolve({
				ownerID: "alice",
				grantID: "grant",
				expiresAt: Date.now() + 60_000,
				allowsDayBriefing: true,
			}),
		readDay: () => Promise.resolve(raw),
	});
	const result = await capability.briefing({
		date: "2026-09-13",
		timeZone: "UTC",
	});
	assert.ok(!JSON.stringify(result).includes("secret"));
	assert.deepEqual(result.events, [{
		id: "e",
		title: "Meeting",
		start: "2026-09-13T10:00:00Z",
		end: "2026-09-13T11:00:00Z",
	}]);
	raw.events[0]!.start = "not-a-time";
	await assert.rejects(
		capability.briefing({ date: "2026-09-13", timeZone: "UTC" }),
		/Invalid briefing result/,
	);
});
Deno.test("post-creation permission failure cannot downgrade known session receipt", async () => {
	const outcomes: SessionOutcome[] = [];
	let checks = 0;
	const response = await fetchVoiceSession(request(), env, {
		authenticate: authenticated,
		reserve: () =>
			Promise.resolve({
				isCurrent: () =>
					++checks === 1
						? Promise.resolve(true)
						: Promise.reject(new Error("Grant store unavailable")),
				record: (value) => {
					outcomes.push(value);
					return Promise.resolve();
				},
			}),
		fetch: () =>
			Promise.resolve(
				Response.json({
					session: { id: "live_known" },
					transport: { sdp: "v=0\r\no=server" },
				}),
			),
	});
	assert.equal(response.status, 502);
	assert.deepEqual(outcomes, [{ state: "created", sessionID: "live_known" }]);
});

Deno.test("only explicit provider client rejections release the reservation", async () => {
	for (
		const [status, body, expected] of [
			[400, { error: { code: "model_not_found" } }, "rejected"],
			[401, { error: { type: "authentication_error" } }, "rejected"],
			[403, { error: { type: "permission_error" } }, "rejected"],
			[404, { error: { type: "not_found_error" } }, "rejected"],
			[400, { error: "unstructured response" }, "unknown"],
			[500, { error: { code: "model_not_found" } }, "unknown"],
			[429, { error: { type: "invalid_request_error" } }, "unknown"],
		] as const
	) {
		const outcomes: SessionOutcome[] = [];
		const response = await fetchVoiceSession(request(), env, {
			authenticate: authenticated,
			reserve: () =>
				Promise.resolve({
					isCurrent: () => Promise.resolve(true),
					record: async (value) => {
						outcomes.push(value);
					},
				}),
			fetch: (() =>
				Promise.resolve(Response.json(body, { status }))) as typeof fetch,
		});
		assert.equal(response.status, 502);
		assert.deepEqual(outcomes, [{ state: expected }]);
	}
});

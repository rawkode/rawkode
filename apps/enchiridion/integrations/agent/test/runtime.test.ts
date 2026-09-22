import { strict as assert } from "node:assert";
import { createOwnerVoiceRuntime } from "../src/runtime.ts";
import {
	createVoiceReservations,
	type VoiceStorage,
} from "../src/reservations.ts";
const owner = { ownerId: "access:alice", email: "alice@example.com" };
const origin = "https://notes.example.com";
const env = {
	WEBSITE_ORIGIN: origin,
	ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
	ACCESS_AUDIENCE: "aud",
	ADMIN_EMAILS: owner.email,
	OPENAI_API_KEY: { get: () => Promise.resolve("test-key") },
	API: {
		fetch: () => Promise.resolve(new Response("unused", { status: 500 })),
	},
};
const storage = (): VoiceStorage => {
	let data = new Map<string, unknown>();
	let tail = Promise.resolve();
	return {
		transaction: <T>(
			action: Parameters<VoiceStorage["transaction"]>[0],
		): Promise<T> => {
			const result = tail.then(async () => {
				const draft = structuredClone(data);
				const result = await action({
					get: <V>(key: string) =>
						Promise.resolve(draft.get(key) as V | undefined),
					put: (key, value) => {
						draft.set(key, value);
						return Promise.resolve();
					},
				});
				data = draft;
				return result as T;
			});
			tail = result.then(() => {}, () => {});
			return result;
		},
	};
};
const request = (path: string, body: unknown = {}) =>
	new Request(origin + path, {
		method: "POST",
		headers: {
			Origin: origin,
			"Content-Type": "application/json",
			"Cf-Access-Jwt-Assertion": "test",
		},
		body: JSON.stringify(body),
	});
const start = () =>
	request("/api/voice/sessions", {
		sdp: "v=0\r\n",
		device: "iphone",
		requestID: "request-number-0001",
	});
Deno.test("voice status exposes only the verified owner's receipts without provider access", async () => {
	const disk = storage();
	const ledger = createVoiceReservations(disk, owner.ownerId);
	await ledger.setEnabled(true);
	const permit = await ledger.reserve(owner, "request-number-0001", "iphone");
	assert.ok(permit);
	await permit.record({ state: "created", sessionID: "live_owned" });
	let current: typeof owner | null = owner;
	let providerCalls = 0;
	let secretReads = 0;
	const handler = createOwnerVoiceRuntime(disk, owner, {
		...env,
		OPENAI_API_KEY: {
			get: () => {
				secretReads++;
				throw new Error("Status must not read model credentials");
			},
		},
	}, {
		authenticate: () => Promise.resolve(current),
		fetch: (() => {
			providerCalls++;
			throw new Error("Status must not call the provider");
		}) as typeof fetch,
	});
	const response = await handler(request("/api/voice/status"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(await response.json(), {
		receipts: await ledger.receipts(),
	});
	current = { ownerId: "access:bob", email: "bob@example.com" };
	assert.equal((await handler(request("/api/voice/status"))).status, 401);
	current = null;
	assert.equal((await handler(request("/api/voice/status"))).status, 401);
	current = owner;
	const crossOrigin = request("/api/voice/status");
	crossOrigin.headers.set("Origin", "https://foreign.example.com");
	assert.equal((await handler(crossOrigin)).status, 403);
	assert.equal(
		(await handler(new Request(origin + "/api/voice/status"))).status,
		403,
	);
	assert.equal(providerCalls, 0);
	assert.equal(secretReads, 0);
});
Deno.test("owner runtime grants explicit start, verifies provider hangup, and idempotently ends", async () => {
	const disk = storage();
	const calls: string[] = [];
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () => Promise.resolve(owner),
		fetch: ((url) => {
			calls.push(String(url));
			return Promise.resolve(
				String(url).endsWith("/hangup")
					? new Response(null, { status: 204 })
					: Response.json({
						session: { id: "live_opaque" },
						transport: { sdp: "v=0\r\n" },
					}),
			);
		}) as typeof fetch,
	});
	assert.equal((await handler(start())).status, 201);
	assert.equal(
		(await handler(request("/api/voice/sessions/foreign/end"))).status,
		404,
	);
	assert.equal(
		(await handler(request("/api/voice/sessions/live_opaque/end"))).status,
		200,
	);
	assert.equal(
		(await handler(request("/api/voice/sessions/live_opaque/end"))).status,
		200,
	);
	assert.equal(calls.length, 2);
	assert.equal(
		(await createVoiceReservations(disk, owner.ownerId).receipts())[0].state,
		"closed",
	);
});
Deno.test("provider hangup failure retains session quota and closed day grants fail", async () => {
	const disk = storage();
	let fail = true;
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () => Promise.resolve(owner),
		fetch: ((url) =>
			Promise.resolve(
				String(url).endsWith("/hangup")
					? new Response(null, { status: fail ? 500 : 204 })
					: Response.json({
						session: { id: "live_opaque" },
						transport: { sdp: "v=0\r\n" },
					}),
			)) as typeof fetch,
	});
	await handler(start());
	assert.equal(
		(await handler(request("/api/voice/sessions/live_opaque/end"))).status,
		502,
	);
	const ledger = createVoiceReservations(disk, owner.ownerId);
	assert.equal(await ledger.isSessionActive("live_opaque"), true);
	fail = false;
	await handler(request("/api/voice/sessions/live_opaque/end"));
	assert.equal(
		(await handler(
			request("/api/voice/sessions/live_opaque/day", {
				date: "2026-09-13",
				timeZone: "Europe/London",
			}),
		)).status,
		403,
	);
});
Deno.test("ongoing voice grant survives creation lease but not revocation", async () => {
	let now = 1000;
	const ledger = createVoiceReservations(
		storage(),
		owner.ownerId,
		undefined,
		() => now,
	);
	await ledger.setEnabled(true);
	const permit = await ledger.reserve(owner, "request-number-0001", "iphone");
	assert.ok(permit);
	await permit.record({ state: "created", sessionID: "live_opaque" });
	now += 60000;
	assert.equal(await permit.isCurrent(), false);
	assert.equal(await ledger.isSessionActive("live_opaque"), true);
	await ledger.setEnabled(false);
	await ledger.setEnabled(true);
	assert.equal(await ledger.isSessionActive("live_opaque"), false);
});
Deno.test("foreign owner cannot invoke runtime or grant voice", async () => {
	const disk = storage();
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () =>
			Promise.resolve({ ownerId: "access:bob", email: "bob@example.com" }),
	});
	assert.equal((await handler(start())).status, 401);
	assert.deepEqual(
		await createVoiceReservations(disk, owner.ownerId).receipts(),
		[],
	);
});

Deno.test("sideband is attached after receipt is durable and before SDP is returned", async () => {
	const disk = storage();
	let attached = false;
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () => Promise.resolve(owner),
		fetch: (() =>
			Promise.resolve(
				Response.json({
					session: { id: "live_opaque" },
					transport: { sdp: "v=0\r\n" },
				}),
			)) as typeof fetch,
		attach: async (identity, requestID, sessionID) => {
			assert.equal(identity.ownerId, owner.ownerId);
			assert.equal(requestID, "request-number-0001");
			assert.equal(
				await createVoiceReservations(disk, owner.ownerId).isSessionActive(
					sessionID,
				),
				true,
			);
			attached = true;
		},
	});
	const result = await handler(start());
	assert.equal(result.status, 201);
	assert.equal(attached, true);
});

Deno.test("explicit provider rejection releases concurrency while preserving request replay protection", async () => {
	const disk = storage();
	let calls = 0;
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () => Promise.resolve(owner),
		fetch: (() => {
			calls++;
			return Promise.resolve(
				calls === 1
					? Response.json({
						error: {
							code: "model_not_found",
							type: "invalid_request_error",
							message: "private provider detail",
						},
					}, { status: 400 })
					: Response.json({
						session: { id: "live_recovered" },
						transport: { sdp: "v=0\r\n" },
					}),
			);
		}) as typeof fetch,
	});
	assert.equal((await handler(start())).status, 502);
	assert.equal((await handler(start())).status, 403);
	assert.equal(
		(await handler(request("/api/voice/sessions", {
			sdp: "v=0\r\n",
			device: "iphone",
			requestID: "request-number-0002",
		}))).status,
		201,
	);
	assert.equal(calls, 2);
	const rows = await createVoiceReservations(disk, owner.ownerId).receipts();
	assert.equal(rows.length, 2);
	assert.equal(rows[0].state, "closed");
	assert.equal(rows[0].sessionID, undefined);
	assert.equal(rows[1].state, "created");
});

Deno.test("recovery requires explicit owner acknowledgement and never calls the provider", async () => {
	const disk = storage();
	const ledger = createVoiceReservations(
		disk,
		owner.ownerId,
		undefined,
		() => 1000,
	);
	await ledger.setEnabled(true);
	assert.ok(await ledger.reserve(owner, "request-number-0001", "iphone"));
	let current = owner;
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () => Promise.resolve(current),
		fetch: (() => {
			throw new Error("Must not call provider");
		}) as typeof fetch,
	});
	const payload = {
		requestID: "request-number-0001",
		acknowledgeUnconfirmedSession: true,
	};
	for (
		const body of [{ requestID: payload.requestID }, {
			...payload,
			acknowledgeUnconfirmedSession: false,
		}]
	) {
		assert.equal(
			(await handler(request("/api/voice/recovery", body))).status,
			400,
		);
	}
	current = { ownerId: "access:bob", email: "bob@example.com" };
	assert.equal(
		(await handler(request("/api/voice/recovery", payload))).status,
		401,
	);
	current = owner;
	const response = await handler(request("/api/voice/recovery", payload));
	assert.equal(response.status, 200);
	const body = await response.json() as {
		receipts: { state: string; recoveredAt?: number }[];
	};
	assert.equal(body.receipts[0].state, "unknown");
	assert.equal(typeof body.receipts[0].recoveredAt, "number");
	assert.equal(
		(await handler(
			request("/api/voice/recovery", {
				...payload,
				requestID: "request-number-9999",
			}),
		)).status,
		409,
	);
});

Deno.test("typed chat is owner authenticated, bounded and uncertain attempts are not replayed", async () => {
	const disk = storage();
	let calls = 0;
	const handler = createOwnerVoiceRuntime(disk, owner, env, {
		authenticate: () => Promise.resolve(owner),
		chat: () => {
			calls++;
			return Promise.reject(new Error("provider unavailable"));
		},
	});
	const invalid = await handler(
		request("/api/voice/chat", { message: "Hi", history: [], owner: "victim" }),
	);
	assert.equal(invalid.status, 400);
	assert.equal(calls, 0);
	const failed = await handler(
		request("/api/voice/chat", { message: "Create task", history: [] }),
	);
	assert.equal(failed.status, 503);
	assert.equal(calls, 1);
	const retry = await handler(
		request("/api/voice/chat", { message: "Create task", history: [] }),
	);
	assert.equal(retry.status, 429);
	assert.equal(calls, 1);
	const wrong = createOwnerVoiceRuntime(storage(), owner, env, {
		authenticate: () => Promise.resolve({ ...owner, ownerId: "access:bob" }),
		chat: () => {
			calls++;
			return Promise.resolve("bad");
		},
	});
	assert.equal(
		(await wrong(request("/api/voice/chat", { message: "Hi", history: [] })))
			.status,
		401,
	);
	assert.equal(calls, 1);
});

Deno.test("typed chat successful execution returns text and releases its lease", async () => {
	let calls = 0;
	const handler = createOwnerVoiceRuntime(storage(), owner, env, {
		authenticate: () => Promise.resolve(owner),
		chat: (delegation) => {
			calls++;
			assert.equal(delegation.transcript.at(-1)?.speaker, "user");
			return Promise.resolve("Hello");
		},
	});
	for (let i = 0; i < 2; i++) {
		const response = await handler(
			request("/api/voice/chat", { message: "Hi", history: [] }),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { text: "Hello" });
	}
	assert.equal(calls, 2);
});

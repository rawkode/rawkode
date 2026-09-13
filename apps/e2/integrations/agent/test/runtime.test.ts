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

import { fetchVoiceSession } from "../src/session.ts";
import { strict as assert } from "node:assert";
import {
	createVoiceReservations,
	type ReservationPolicy,
	type VoiceStorage,
} from "../src/reservations.ts";

/** Serializable durable-storage fixture; separate broker instances share bytes.
 * Writes commit together, or are discarded if the transaction throws. */
const fixtureStorage = () => {
	let data = new Map<string, unknown>();
	let tail: Promise<unknown> = Promise.resolve();
	let failCommit = false;
	const storage: VoiceStorage = {
		transaction: <T>(
			action: Parameters<VoiceStorage["transaction"]>[0],
		): Promise<T> => {
			const run = tail.then(async () => {
				const staged = structuredClone(data);
				const value = await action({
					get: <Value>(key: string) =>
						Promise.resolve(
							structuredClone(staged.get(key)) as Value | undefined,
						),
					put: (key: string, value: unknown) => {
						staged.set(key, structuredClone(value));
						return Promise.resolve();
					},
				});
				if (failCommit) {
					failCommit = false;
					throw new Error("Disk unavailable");
				}
				data = staged;
				return value as T;
			});
			tail = run.catch(() => {});
			return run;
		},
	};
	return {
		storage,
		failNextCommit: () => {
			failCommit = true;
		},
	};
};
const owner = { ownerId: "access:alice", email: "alice@example.com" };
const policy: ReservationPolicy = {
	maximumConcurrent: 1,
	maximumDailyAttempts: 2,
	creationLeaseMs: 1000,
	maximumRecords: 20,
};
const id = (value: number) =>
	`request-number-${value.toString().padStart(4, "0")}`;

Deno.test("reservations are disabled until enabled and bound to one authenticated owner", async () => {
	const { storage } = fixtureStorage();
	const ledger = createVoiceReservations(storage, owner.ownerId, policy);
	assert.equal(await ledger.reserve(owner, id(1), "iphone"), null);
	await ledger.setEnabled(true);
	assert.equal(
		await ledger.reserve({ ...owner, ownerId: "access:bob" }, id(1), "iphone"),
		null,
	);
	await assert.rejects(
		createVoiceReservations(storage, "access:bob", policy).receipts(),
		/owner mismatch/,
	);
	assert.ok(await ledger.reserve(owner, id(1), "iphone"));
});
Deno.test("racing requests and replay across instances create at most one permit", async () => {
	const { storage } = fixtureStorage();
	const first = createVoiceReservations(storage, owner.ownerId, policy);
	const second = createVoiceReservations(storage, owner.ownerId, policy);
	await first.setEnabled(true);
	const permits = await Promise.all([
		first.reserve(owner, id(1), "iphone"),
		second.reserve(owner, id(1), "mac"),
		second.reserve(owner, id(2), "carplay"),
	]);
	assert.equal(permits.filter(Boolean).length, 1);
	assert.equal((await first.receipts()).length, 1);
	assert.equal(
		await createVoiceReservations(storage, owner.ownerId, policy).reserve(
			owner,
			id(1),
			"iphone",
		),
		null,
	);
});
Deno.test("crashed creation lease becomes uncertain and cannot silently release quota", async () => {
	const { storage } = fixtureStorage();
	let now = Date.parse("2026-09-13T12:00:00Z");
	const ledger = createVoiceReservations(
		storage,
		owner.ownerId,
		policy,
		() => now,
	);
	await ledger.setEnabled(true);
	assert.ok(await ledger.reserve(owner, id(1), "iphone"));
	now += 1001;
	const recovered = createVoiceReservations(
		storage,
		owner.ownerId,
		policy,
		() => now,
	);
	assert.equal((await recovered.receipts())[0]?.state, "unknown");
	assert.equal(await recovered.reserve(owner, id(2), "iphone"), null);
	await recovered.reconcile(id(1), { state: "notCreated" });
	assert.ok(await recovered.reserve(owner, id(2), "iphone"));
	assert.equal(await recovered.reserve(owner, id(1), "iphone"), null);
});
Deno.test("known session receipts survive unknown writes, revocation and restart", async () => {
	const { storage } = fixtureStorage();
	const ledger = createVoiceReservations(storage, owner.ownerId, policy);
	await ledger.setEnabled(true);
	const permit = (await ledger.reserve(owner, id(1), "iphone"))!;
	await permit.record({ state: "created", sessionID: "live_1" });
	await permit.record({ state: "unknown" });
	await ledger.setEnabled(false);
	assert.equal(await permit.isCurrent(), false);
	await ledger.setEnabled(true);
	assert.equal(await permit.isCurrent(), false);
	await permit.record({ state: "created", sessionID: "live_1" });
	await assert.rejects(
		permit.record({ state: "created", sessionID: "live_other" }),
		/Conflicting/,
	);
	await assert.rejects(
		ledger.reconcile(id(1), { state: "notCreated" }),
		/known session/,
	);
	await assert.rejects(
		ledger.reconcile(id(1), { state: "closed", sessionID: "foreign" }),
		/mismatch/,
	);
	await ledger.reconcile(id(1), { state: "closed", sessionID: "live_1" });
	const restored =
		(await createVoiceReservations(storage, owner.ownerId, policy).receipts())[
			0
		]!;
	assert.equal(restored.state, "closed");
	assert.equal(restored.sessionID, "live_1");
	assert.ok(!JSON.stringify(restored).includes("nonce"));
});
Deno.test("daily attempt quota persists after closure and rolls over without replaying old IDs", async () => {
	const { storage } = fixtureStorage();
	let now = Date.parse("2026-09-13T12:00:00Z");
	const ledger = createVoiceReservations(
		storage,
		owner.ownerId,
		policy,
		() => now,
	);
	await ledger.setEnabled(true);
	for (const number of [1, 2]) {
		const permit = (await ledger.reserve(owner, id(number), "iphone"))!;
		await permit.record({ state: "created", sessionID: `live_${number}` });
		await ledger.reconcile(id(number), {
			state: "closed",
			sessionID: `live_${number}`,
		});
	}
	assert.equal(await ledger.reserve(owner, id(3), "iphone"), null);
	now += 86_400_000;
	assert.equal(await ledger.reserve(owner, id(1), "iphone"), null);
	assert.ok(await ledger.reserve(owner, id(3), "iphone"));
});
Deno.test("failed durable admission never returns a usable permit", async () => {
	const fixture = fixtureStorage();
	const ledger = createVoiceReservations(
		fixture.storage,
		owner.ownerId,
		policy,
	);
	await ledger.setEnabled(true);
	fixture.failNextCommit();
	await assert.rejects(
		ledger.reserve(owner, id(1), "iphone"),
		/Disk unavailable/,
	);
	assert.equal((await ledger.receipts()).length, 0);
	assert.ok(await ledger.reserve(owner, id(1), "iphone"));
});

Deno.test("late known provider session survives prior uncertainty reconciliation", async () => {
	const { storage } = fixtureStorage();
	let now = 1_000_000;
	const ledger = createVoiceReservations(
		storage,
		owner.ownerId,
		policy,
		() => now,
	);
	await ledger.setEnabled(true);
	const permit = (await ledger.reserve(owner, id(1), "iphone"))!;
	now += 1001;
	await ledger.reconcile(id(1), { state: "notCreated" });
	await permit.record({ state: "created", sessionID: "live_late" });
	const row = (await ledger.receipts())[0]!;
	assert.equal(row.sessionID, "live_late");
	assert.equal(row.state, "created");
	assert.equal(row.closedAt, undefined);
	assert.equal(await ledger.reserve(owner, id(2), "iphone"), null);
});
Deno.test("record capacity fails closed without deleting replay protection", async () => {
	const { storage } = fixtureStorage();
	const ledger = createVoiceReservations(storage, owner.ownerId, {
		...policy,
		maximumRecords: 1,
	});
	await ledger.setEnabled(true);
	const permit = (await ledger.reserve(owner, id(1), "iphone"))!;
	await permit.record({ state: "created", sessionID: "live_1" });
	await ledger.reconcile(id(1), { state: "closed", sessionID: "live_1" });
	assert.equal(await ledger.reserve(owner, id(2), "iphone"), null);
	assert.equal(await ledger.reserve(owner, id(1), "iphone"), null);
});

Deno.test("session handler uses durable reservation to prevent a second provider creation", async () => {
	const { storage } = fixtureStorage();
	const ledger = createVoiceReservations(storage, owner.ownerId, policy);
	await ledger.setEnabled(true);
	let providerCalls = 0;
	const env = {
		WEBSITE_ORIGIN: "https://notes.example",
		ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
		ACCESS_AUDIENCE: "aud",
		ADMIN_EMAILS: owner.email,
		OPENAI_API_KEY: { get: () => Promise.resolve("test-project-key") },
	};
	const request = () =>
		new Request("https://notes.example/api/voice/sessions", {
			method: "POST",
			headers: {
				Origin: env.WEBSITE_ORIGIN,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sdp: "v=0\r\no=client",
				device: "iphone",
				requestID: id(1),
			}),
		});
	const dependencies = {
		authenticate: () => Promise.resolve(owner),
		reserve: ledger.reserve,
		fetch: () => {
			providerCalls++;
			return Promise.resolve(
				Response.json({
					session: { id: "live_once" },
					transport: { sdp: "v=0\r\no=server" },
				}),
			);
		},
	};
	const responses = await Promise.all([
		fetchVoiceSession(request(), env, dependencies),
		fetchVoiceSession(request(), env, dependencies),
	]);
	assert.deepEqual(responses.map((response) => response.status).sort(), [
		201,
		403,
	]);
	assert.equal(providerCalls, 1);
	assert.equal((await ledger.receipts())[0]?.sessionID, "live_once");
});

Deno.test("closed receipt archival frees hot capacity without replaying archived requests", async () => {
	const { storage } = fixtureStorage();
	let now = Date.UTC(2026, 8, 13);
	const ledger = createVoiceReservations(storage, owner.ownerId, {
		...policy,
		maximumRecords: 1,
	}, () => now);
	await ledger.setEnabled(true);
	const first = await ledger.reserve(owner, id(1), "iphone");
	assert.ok(first);
	await first.record({ state: "created", sessionID: "session1" });
	await ledger.reconcile(id(1), { state: "closed", sessionID: "session1" });
	now += 86400000;
	const second = await ledger.reserve(owner, id(2), "iphone");
	assert.ok(second);
	assert.equal(await ledger.reserve(owner, id(1), "iphone"), null);
	await second.record({ state: "created", sessionID: "session2" });
	await ledger.reconcile(id(2), { state: "closed", sessionID: "session2" });
	const restored = createVoiceReservations(storage, owner.ownerId, {
		...policy,
		maximumRecords: 1,
	}, () => now);
	assert.equal(await restored.reserve(owner, id(1), "iphone"), null);
	await first.record({ state: "created", sessionID: "session1" });
	assert.equal(await restored.isSessionActive("session1"), false);
});

Deno.test("rejected attempts retain daily quota and cannot erase a known provider session", async () => {
	const { storage } = fixtureStorage();
	const ledger = createVoiceReservations(storage, owner.ownerId, policy);
	await ledger.setEnabled(true);
	const rejected = (await ledger.reserve(owner, id(1), "iphone"))!;
	await rejected.record({ state: "rejected" });
	assert.equal(await rejected.isCurrent(), false);
	assert.equal(await ledger.reserve(owner, id(1), "iphone"), null);
	const created = (await ledger.reserve(owner, id(2), "iphone"))!;
	await created.record({ state: "created", sessionID: "live_2" });
	await assert.rejects(
		created.record({ state: "rejected" }),
		/Cannot reject a created session/,
	);
	await ledger.reconcile(id(2), { state: "closed", sessionID: "live_2" });
	assert.equal(await ledger.reserve(owner, id(3), "iphone"), null);
});

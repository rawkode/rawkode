import { strict as assert } from "node:assert";
import type { EntitiesApi, ProjectionBatch } from "@e2/entities";
import type { Connection, OAuthIntegrationApi } from "@e2/oauth-client";
import { syncCollection } from "../integrations/google/src/mirror.ts";
import {
	drainContactProjectionOutbox,
	type EntitiesAdminBinding,
	googleContactProjection,
} from "../integrations/google/src/projection.ts";
import type { AccountEnv } from "../integrations/google/src/env.ts";
import { testDatabase } from "./legacy/d1.ts";

const connection: Connection = {
	id: "google-account",
	ownerId: "owner",
	appId: "google",
	appName: "Google Workspace",
	providerId: "google",
	accountId: "subject",
	accountLabel: "owner@example.test",
	scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
	status: "connected",
	grantVersion: 1,
	expiresAt: Date.now() + 60_000,
	createdAt: 1,
	services: ["integrations-google"],
};

const oauth: OAuthIntegrationApi = {
	listConnections: () => Promise.resolve([connection]),
	getAccessToken: () =>
		Promise.resolve({
			accessToken: "access",
			tokenType: "Bearer",
			expiresAt: Date.now() + 60_000,
			scopes: connection.scopes,
		}),
	canDeleteConnection: () => Promise.resolve(true),
	getConnectionForCleanup: () => Promise.resolve(connection),
};

const provider = () => {
	let records: Record<string, unknown>[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		assert.equal(
			new URL(input instanceof Request ? input.url : input).pathname,
			"/v1/people/me/connections",
		);
		assert.equal(
			new Headers(init?.headers).get("Authorization"),
			"Bearer access",
		);
		return Promise.resolve(
			Response.json({
				connections: records,
				nextSyncToken: `sync-${crypto.randomUUID()}`,
			}),
		);
	};
	return {
		origin: "http://127.0.0.1:8790",
		records: (next: Record<string, unknown>[]) => {
			records = next;
		},
		close: () => {
			globalThis.fetch = originalFetch;
		},
	};
};

const environment = (
	db: AccountEnv["DB"],
	origin: string,
): AccountEnv => ({
	DB: db,
	LOCAL_PROVIDER_ORIGIN: origin,
} as AccountEnv);

const contact = {
	resourceName: "people/person-1",
	names: [
		{ displayName: "Ada Lovelace" },
		{ displayName: "Augusta Ada King" },
	],
	emailAddresses: [
		{ value: "ADA@example.test" },
		{ value: "not-an-email" },
	],
	phoneNumbers: [{ value: "+44 20 1234 5678" }],
	photos: [{ url: "https://images.example.test/ada.jpg" }],
};

Deno.test("Google contact normalization has stable projection identity and Person fields", async () => {
	const first = await googleContactProjection(
		connection.id,
		"people/person-1",
		contact,
		false,
	);
	const retry = await googleContactProjection(
		connection.id,
		"people/person-1",
		contact,
		false,
	);
	assert.deepEqual(retry, first);
	assert.equal(first.label, "Ada Lovelace");
	assert.deepEqual(first.aliases, [
		"Augusta Ada King",
		"ada@example.test",
	]);
	assert.deepEqual(first.values, {
		"field:person:name": "Ada Lovelace",
		"field:person:emails": ["ada@example.test"],
		"field:person:phones": ["+44 20 1234 5678"],
		"field:person:avatar": "https://images.example.test/ada.jpg",
	});
	const changed = await googleContactProjection(
		connection.id,
		"people/person-1",
		{ ...contact, names: [{ displayName: "Ada King" }] },
		false,
	);
	assert.notEqual(changed.sourceRevision, first.sourceRevision);
	assert.notEqual(changed.projectionId, first.projectionId);
});

Deno.test("contact provider record, projection outbox, and cursor commit atomically", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/google/migrations",
	);
	const upstream = provider();
	try {
		upstream.records([contact]);
		await syncCollection(
			environment(db as unknown as AccountEnv["DB"], upstream.origin),
			oauth,
			connection,
			"contacts",
		);
		const stored = sqlite.query(
			"SELECT resource_id, source_revision FROM google_records",
		).get() as { resource_id: string; source_revision: string };
		const queued = sqlite.query(
			'SELECT projection_id, source_revision, label, aliases, "values", deleted FROM entity_projection_outbox',
		).get() as Record<string, unknown>;
		assert.equal(stored.resource_id, "people/person-1");
		assert.equal(queued.source_revision, stored.source_revision);
		assert.equal(queued.label, "Ada Lovelace");
		assert.equal(queued.deleted, 0);
		assert.match(String(queued.projection_id), /people\/person-1/);
		assert.equal(
			sqlite.query("SELECT sync_token FROM google_syncs").get()?.sync_token
				?.toString().startsWith("sync-"),
			true,
		);

		sqlite.exec(
			"UPDATE google_syncs SET sync_token = NULL, generation = 'empty-sweep'",
		);
		upstream.records([]);
		await syncCollection(
			environment(db as unknown as AccountEnv["DB"], upstream.origin),
			oauth,
			connection,
			"contacts",
		);
		const tombstone = sqlite.query(
			"SELECT source_revision, deleted FROM entity_projection_outbox WHERE deleted = 1",
		).get() as { source_revision: string; deleted: number };
		assert.equal(tombstone.deleted, 1);
		assert.match(tombstone.source_revision, /^deleted:active:/);
		let delivered: ProjectionBatch | undefined;
		await drainContactProjectionOutbox(
			db as unknown as AccountEnv["DB"],
			{
				admin: () =>
					Promise.resolve(
						{
							upsertProjectionBatch: (batch: ProjectionBatch) => {
								delivered = batch;
								return Promise.resolve({ changed: batch.records.length });
							},
							[Symbol.dispose]() {},
						} as unknown as EntitiesApi & Disposable,
					),
			},
			connection.id,
		);
		assert.deepEqual(
			delivered?.records.map((record) => record.deleted),
			[false, true],
		);
	} finally {
		upstream.close();
		sqlite.close();
	}
});

Deno.test("a failed outbox write rolls back its contact staging and cursor publication", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/google/migrations",
	);
	const upstream = provider();
	try {
		upstream.records([contact]);
		sqlite.exec(`
      CREATE TRIGGER reject_projection
      BEFORE INSERT ON entity_projection_outbox
      BEGIN SELECT RAISE(ABORT, 'projection rejected'); END
    `);
		await assert.rejects(
			syncCollection(
				environment(db as unknown as AccountEnv["DB"], upstream.origin),
				oauth,
				connection,
				"contacts",
			),
			/projection rejected/,
		);
		assert.equal(
			sqlite.query("SELECT count(*) AS count FROM google_staging").get()?.count,
			0,
		);
		assert.equal(
			sqlite.query("SELECT count(*) AS count FROM google_records").get()?.count,
			0,
		);
		assert.equal(
			sqlite.query("SELECT sync_token FROM google_syncs").get()?.sync_token,
			null,
		);
	} finally {
		upstream.close();
		sqlite.close();
	}
});

Deno.test("outbox delivery is bounded and retries the same entity projection after a lost acknowledgement", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/google/migrations",
	);
	const upstream = provider();
	const received: ProjectionBatch[] = [];
	let failAfterApplying = true;
	const applied = new Set<string>();
	const binding: EntitiesAdminBinding = {
		admin: () =>
			Promise.resolve(
				{
					upsertProjectionBatch: (batch: ProjectionBatch) => {
						received.push(batch);
						batch.records.forEach((record) =>
							applied.add(
								`${record.resourceType}:${record.resourceId}:${record.sourceRevision}`,
							)
						);
						if (failAfterApplying) {
							return Promise.reject(new Error("acknowledgement lost"));
						}
						return Promise.resolve({ changed: 0 });
					},
					[Symbol.dispose]() {},
				} as unknown as EntitiesApi & Disposable,
			),
	};
	try {
		upstream.records([
			contact,
			{
				...contact,
				resourceName: "people/person-2",
				names: [{ displayName: "Grace Hopper" }],
			},
		]);
		await syncCollection(
			environment(db as unknown as AccountEnv["DB"], upstream.origin),
			oauth,
			connection,
			"contacts",
		);
		await assert.rejects(
			drainContactProjectionOutbox(
				db as unknown as AccountEnv["DB"],
				binding,
				connection.id,
				1,
			),
			/will retry/,
		);
		assert.equal(
			sqlite.query(
				"SELECT attempts FROM entity_projection_outbox ORDER BY sequence LIMIT 1",
			).get()?.attempts,
			1,
		);
		failAfterApplying = false;
		const retried = await drainContactProjectionOutbox(
			db as unknown as AccountEnv["DB"],
			binding,
			connection.id,
			1,
		);
		assert.deepEqual(retried, { delivered: 1, pending: true });
		assert.deepEqual(received[1]!.records, received[0]!.records);
		assert.equal(applied.size, 1);
		assert.equal(
			sqlite.query(
				"SELECT count(*) AS count FROM entity_projection_outbox",
			).get()?.count,
			1,
		);
	} finally {
		upstream.close();
		sqlite.close();
	}
});

Deno.test("a poison contact is quarantined without stalling later projections", async () => {
	const { db, sqlite } = await testDatabase(
		"../../integrations/google/migrations",
	);
	const upstream = provider();
	const delivered = new Set<string>();
	const binding: EntitiesAdminBinding = {
		admin: () =>
			Promise.resolve(
				{
					upsertProjectionBatch: (batch: ProjectionBatch) => {
						if (
							batch.records.some((row) => row.resourceId === "people/person-1")
						) {
							return Promise.reject(new Error("invalid entity"));
						}
						batch.records.forEach((row) => delivered.add(row.resourceId));
						return Promise.resolve({ changed: batch.records.length });
					},
					[Symbol.dispose]() {},
				} as unknown as EntitiesApi & Disposable,
			),
	};
	try {
		upstream.records([contact, {
			...contact,
			resourceName: "people/person-2",
			names: [{ displayName: "Grace Hopper" }],
		}]);
		await syncCollection(
			environment(db as unknown as AccountEnv["DB"], upstream.origin),
			oauth,
			connection,
			"contacts",
		);
		await assert.rejects(
			drainContactProjectionOutbox(
				db as unknown as AccountEnv["DB"],
				binding,
				connection.id,
			),
			/will retry/,
		);
		assert.deepEqual([...delivered], ["people/person-2"]);
		for (let attempt = 2; attempt <= 4; attempt++) {
			await assert.rejects(
				drainContactProjectionOutbox(
					db as unknown as AccountEnv["DB"],
					binding,
					connection.id,
				),
				/will retry/,
			);
		}
		assert.deepEqual(
			await drainContactProjectionOutbox(
				db as unknown as AccountEnv["DB"],
				binding,
				connection.id,
			),
			{ delivered: 0, pending: false },
		);
		const quarantined = sqlite.query(
			"SELECT attempts,quarantined_at,last_error FROM entity_projection_outbox",
		).get();
		assert.equal(quarantined?.attempts, 5);
		assert.equal(typeof quarantined?.quarantined_at, "number");
		assert.equal(quarantined?.last_error, "Entity projection failed");

		await db.prepare(
			`INSERT INTO entity_projection_outbox
		   (projection_id,connection_id,owner_id,resource_type,resource_id,
		    source_revision,label,aliases,"values",deleted,created_at)
		   VALUES ('later','google-account','owner','contact','people/person-3',
		           'active:later','Later','[]','{}',0,1)`,
		).run();
		assert.deepEqual(
			await drainContactProjectionOutbox(
				db as unknown as AccountEnv["DB"],
				binding,
				connection.id,
			),
			{ delivered: 1, pending: false },
		);
		assert.equal(delivered.has("people/person-3"), true);
	} finally {
		upstream.close();
		sqlite.close();
	}
});

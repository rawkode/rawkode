import { strict as assert } from "node:assert";
import {
	createVoiceTaskTools,
	type VoiceTaskBinding,
} from "../src/task-tools.ts";
const context = { toolCallId: "entity", messages: [], context: {} };
const saved = {
	id: "entity-id",
	label: "Giggle",
	bodyDocumentId: "entity:entity-id",
	tagIds: ["web-links"],
	revision: 1,
	archived: false,
	values: { "field:url": "https://giggle.com" },
};
const setup = (failure = false) => {
	const calls: { input: unknown; provenance: { actor: string } }[] = [];
	let current = saved;
	const api = {
		[Symbol.dispose]() {},
		createEntity: (input: unknown, provenance: { actor: string }) => {
			calls.push({ input, provenance });
			return failure
				? Promise.reject(new Error("Lost reply private"))
				: Promise.resolve({ ...current, secret: "hidden" });
		},
		getEntity: () => Promise.resolve({ ...current, secret: "hidden" }),
		setUserValues: (
			_id: string,
			values: typeof saved.values,
			_clear: string[],
			revision: number,
		) => {
			if (revision !== current.revision) {
				return Promise.resolve({
					ok: false,
					entity: current,
					conflicts: [{
						entityId: current.id,
						expectedRevision: revision,
						actualRevision: current.revision,
					}],
				});
			}
			current = { ...current, values, revision: current.revision + 1 };
			return Promise.resolve({ ok: true, entity: current, conflicts: [] });
		},
	};
	const tools = createVoiceTaskTools({
		owner: "access:alice",
		signal: new AbortController().signal,
		check: () => Promise.resolve(),
		isCurrent: () => Promise.resolve(true),
		binding: {
			admin: (owner: string) => {
				assert.equal(owner, "access:alice");
				return Promise.resolve(api);
			},
		} as unknown as VoiceTaskBinding,
	});
	return { tools, calls };
};
const input = {
	label: "Giggle",
	tagIds: ["web-links"],
	values: { "field:url": "https://giggle.com" },
};
Deno.test("voice saves and reads back a link with verified owner and projected values", async () => {
	const { tools, calls } = setup();
	const result = await tools.entityCreate.execute!(input, context);
	const read = await tools.entityRead.execute!({ id: saved.id }, context);
	assert.equal(
		(result as { result: { entity: typeof saved } }).result.entity.id,
		saved.id,
	);
	assert.equal(
		(read as { result: { entity: typeof saved } }).result.entity
			.values["field:url"],
		"https://giggle.com",
	);
	assert.equal(calls[0].provenance.actor, "access:alice");
	assert.ok(!JSON.stringify(result).includes("hidden"));
	assert.ok(!JSON.stringify(read).includes("hidden"));
});
Deno.test("identical entity creates coalesce within one turn only", async () => {
	const { tools, calls } = setup();
	await tools.entityCreate.execute!(input, context);
	await tools.entityCreate.execute!(input, context);
	assert.equal(calls.length, 1);
});
Deno.test("entity field update carries revision and preserves conflict as failure", async () => {
	const { tools } = setup();
	const change = {
		id: saved.id,
		expectedRevision: 1,
		values: { "field:url": "https://example.com" },
		clearFieldIds: [],
	};
	const first = await tools.entityUpdateValues.execute!(change, context);
	assert.equal((first as { result: { ok: boolean } }).result.ok, true);
	const conflict = await tools.entityUpdateValues.execute!(change, context);
	assert.equal((conflict as { result: { ok: boolean } }).result.ok, false);
	const read = await tools.entityRead.execute!({ id: saved.id }, context);
	assert.equal(
		(read as { result: { entity: typeof saved } }).result.entity
			.values["field:url"],
		"https://example.com",
	);
});
Deno.test("unknown entity creation never claims success or retries and blocks shared writes", async () => {
	const { tools, calls } = setup(true);
	const response = await tools.entityCreate.execute!(input, context);
	assert.equal((response as { outcome: string }).outcome, "unknown");
	assert.ok(!JSON.stringify(response).includes("private"));
	await assert.rejects(
		() => tools.entityCreate.execute!(input, context) as Promise<unknown>,
		/uncertain/,
	);
	await assert.rejects(
		() =>
			tools.taskCreate.execute!(
				{ title: "Must not retry" },
				context,
			) as Promise<unknown>,
		/uncertain/,
	);
	assert.equal(calls.length, 1);
});
Deno.test("entity tools reject owner injection and undefined identity readback", async () => {
	const { tools, calls } = setup();
	await assert.rejects(() =>
		tools.entityCreate.execute!(
			{ ...input, owner: "access:bob" } as never,
			context,
		) as Promise<unknown>
	);
	assert.equal(calls.length, 0);
	const result = await tools.entityRead.execute!(
		{ id: "other-entity" },
		context,
	);
	assert.equal((result as { outcome: string }).outcome, "unavailable");
});

Deno.test("voice bookmark tools persist through the real SQLite entity store and reject stale edits", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { drizzle } = await import("drizzle-orm/node-sqlite");
	const { migrate } = await import("drizzle-orm/node-sqlite/migrator");
	const { fileURLToPath } = await import("node:url");
	const { createEntityStore } = await import(
		"../../../core/entities/src/storage.ts"
	);
	const database = new DatabaseSync(":memory:");
	try {
		const db = drizzle({ client: database });
		migrate(db, {
			migrationsFolder: fileURLToPath(
				new URL("../../../core/entities/migrations", import.meta.url),
			),
		});
		const store = createEntityStore(
			db as unknown as import("../../../core/entities/src/storage.ts").EntityDatabase,
		);
		const provenance = {
			actor: "access:alice",
			cause: "fixture",
			rationale: "Local test schema",
		};
		const tag = store.createUserTag({
			name: "Web links",
			parentId: "base:document",
		}, provenance);
		const field = store.defineField({
			tagId: tag.id,
			key: "bookmark_url",
			label: "URL",
			type: "url",
			cardinality: "single",
		}, provenance);
		const api = {
			[Symbol.dispose]() {},
			createEntity: (...args: Parameters<typeof store.createEntity>) =>
				Promise.resolve(store.createEntity(...args)),
			getEntity: (...args: Parameters<typeof store.getEntity>) =>
				Promise.resolve(store.getEntity(...args)),
			setUserValues: (...args: Parameters<typeof store.setUserValues>) =>
				Promise.resolve(store.setUserValues(...args)),
		};
		const tools = createVoiceTaskTools({
			owner: "access:alice",
			signal: new AbortController().signal,
			check: () => Promise.resolve(),
			isCurrent: () => Promise.resolve(true),
			binding: {
				admin: (owner: string) => {
					assert.equal(owner, "access:alice");
					return Promise.resolve(api);
				},
			} as unknown as VoiceTaskBinding,
		});
		const created = await tools.entityCreate.execute!({
			label: "Giggle",
			tagIds: [tag.id],
			values: { [field.id]: "https://giggle.com" },
		}, context) as { result: { entity: { id: string; revision: number } } };
		const entityId = created.result.entity.id;
		assert.equal(
			store.getEntity(entityId)?.values[field.id],
			"https://giggle.com",
		);
		const persisted = await tools.entityRead.execute!(
			{ id: entityId },
			context,
		) as { result: { entity: { values: Record<string, unknown> } } };
		assert.equal(
			persisted.result.entity.values[field.id],
			"https://giggle.com",
		);
		const update = {
			id: entityId,
			expectedRevision: created.result.entity.revision,
			values: { [field.id]: "https://example.com" },
			clearFieldIds: [],
		};
		const changed = await tools.entityUpdateValues.execute!(
			update,
			context,
		) as { result: { ok: boolean } };
		assert.equal(changed.result.ok, true);
		const conflict = await tools.entityUpdateValues.execute!(
			update,
			context,
		) as { result: { ok: boolean } };
		assert.equal(conflict.result.ok, false);
		const reopened = createEntityStore(
			db as unknown as import("../../../core/entities/src/storage.ts").EntityDatabase,
		);
		assert.equal(
			reopened.getEntity(entityId)?.values[field.id],
			"https://example.com",
		);
	} finally {
		database.close();
	}
});

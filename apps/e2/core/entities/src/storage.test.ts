import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { BASE_TAGS, INTEGRATION_TAGS, MAX_TAG_DEPTH } from "@e2/entities";
import {
	createEntityStore,
	type EntityDatabase,
	initializeEntityStore,
} from "./storage.ts";

const migrationConfig = {
	migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
};
const provenance = {
	actor: "test:alice",
	cause: "test-run",
	rationale: "Exercise the entity contract",
};
const fixture = () => {
	const database = new DatabaseSync(":memory:");
	const db = drizzle({ client: database });
	migrate(db, migrationConfig);
	let sequence = 0;
	const uuid = () =>
		`00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
	return {
		database,
		entities: createEntityStore(
			db as unknown as EntityDatabase,
			() => `2026-09-10T00:00:${String(sequence).padStart(2, "0")}.000Z`,
			uuid,
		),
	};
};

Deno.test("initialization migrates before the store seeds locked tags", async () => {
	const database = new DatabaseSync(":memory:");
	const db = drizzle({ client: database });
	let migrated = false;
	try {
		const entities = await initializeEntityStore(
			db as unknown as EntityDatabase,
			() => {
				migrate(db, migrationConfig);
				migrated = true;
			},
		);
		assert.equal(migrated, true);
		assert.equal(entities.listTags().length, 18);
	} finally {
		database.close();
	}
});

Deno.test("seeds ten stable bases and locked provider tags", () => {
	const { database, entities } = fixture();
	try {
		const tags = entities.listTags();
		assert.deepEqual(
			tags.filter((tag) => tag.kind === "base").map((tag) => tag.id).sort(),
			Object.values(BASE_TAGS).sort(),
		);
		assert.deepEqual(
			tags.filter((tag) => tag.kind === "integration").map((tag) => tag.id)
				.sort(),
			Object.values(INTEGRATION_TAGS).sort(),
		);
		assert.throws(() =>
			entities.createUserTag({
				name: "Bad",
				parentId: INTEGRATION_TAGS.googleContact,
			}, provenance)
		);
	} finally {
		database.close();
	}
});

Deno.test("user inheritance is bounded and inherited field keys are immutable", () => {
	const { database, entities } = fixture();
	try {
		let parentId: string = BASE_TAGS.person;
		for (let depth = 1; depth <= MAX_TAG_DEPTH; depth++) {
			parentId =
				entities.createUserTag({ name: `Level ${depth}`, parentId }, provenance)
					.id;
		}
		assert.throws(() =>
			entities.createUserTag({ name: "Too deep", parentId }, provenance)
		);
		const engineer = entities.createUserTag({
			name: "Engineer",
			parentId: BASE_TAGS.person,
		}, provenance);
		assert.throws(() =>
			entities.defineField({
				tagId: engineer.id,
				key: "name",
				label: "Other name",
				type: "text",
				cardinality: "single",
			}, provenance)
		);
		assert.throws(() =>
			entities.defineField({
				tagId: engineer.id,
				key: "Bad-Key",
				label: "Bad",
				type: "text",
				cardinality: "single",
			}, provenance)
		);
	} finally {
		database.close();
	}
});

Deno.test("same-root tags compose typed fields and cross-root tags are rejected", () => {
	const { database, entities } = fixture();
	try {
		const engineer = entities.createUserTag({
			name: "Engineer",
			parentId: BASE_TAGS.person,
		}, provenance);
		const language = entities.defineField({
			tagId: engineer.id,
			key: "language",
			label: "Language",
			type: "enum",
			cardinality: "single",
			options: ["TypeScript", "Rust"],
			required: true,
			defaultValue: "TypeScript",
		}, provenance);
		const entity = entities.createEntity({
			label: "Ada",
			tagIds: [BASE_TAGS.person, engineer.id],
			values: { "field:person:name": "Ada Lovelace", [language.id]: "Rust" },
		}, provenance);
		assert.equal(entity.bodyDocumentId, `entity:${entity.id}`);
		assert.equal(entity.values[language.id], "Rust");
		assert.throws(() =>
			entities.createEntity({
				label: "Mixed",
				tagIds: [BASE_TAGS.person, BASE_TAGS.company],
				values: { "field:person:name": "Mixed", "field:company:name": "Mixed" },
			}, provenance)
		);
		assert.throws(() =>
			entities.setUserValues(
				entity.id,
				{ [language.id]: "Go" },
				[],
				entity.revision,
				provenance,
			)
		);
		const quickPerson = entities.createEntity({
			label: "Grace Hopper",
			tagIds: [BASE_TAGS.person],
		}, provenance);
		const quickTopic = entities.createEntity({
			label: "Compilers",
			tagIds: [BASE_TAGS.topic],
		}, provenance);
		assert.equal(quickPerson.values["field:person:name"], "Grace Hopper");
		assert.equal(quickTopic.values["field:topic:name"], "Compilers");
	} finally {
		database.close();
	}
});

Deno.test("bounded indexed search finds labels and aliases and filters roots", () => {
	const { database, entities } = fixture();
	try {
		const person = entities.createEntity({
			label: "Ada Lovelace",
			tagIds: [BASE_TAGS.person],
			aliases: ["Enchantress of Numbers"],
		}, provenance);
		entities.createEntity({
			label: "Ada Project",
			tagIds: [BASE_TAGS.project],
		}, provenance);
		for (let index = 0; index < 60; index++) {
			entities.createEntity({
				label: `Ada Project ${String(index).padStart(2, "0")}`,
				tagIds: [BASE_TAGS.project],
			}, provenance);
		}
		assert.equal(
			entities.searchEntities("ada", { rootId: BASE_TAGS.person })[0]?.id,
			person.id,
		);
		assert.equal(entities.searchEntities("enchantress")[0]?.id, person.id);
		assert.equal(entities.searchEntities("", { limit: 1 }).length, 1);
		assert.throws(() => entities.searchEntities("x", { limit: 51 }));
	} finally {
		database.close();
	}
});

Deno.test("projection batches are idempotent and user values override preferred scalar sources", () => {
	const { database, entities } = fixture();
	try {
		const google = {
			provider: "google",
			connectionId: "account-a",
			provenance,
			records: [{
				resourceType: "contact",
				resourceId: "people/1",
				sourceRevision: "1",
				tagId: INTEGRATION_TAGS.googleContact,
				label: "Ada",
				aliases: ["ada@example.com"],
				values: {
					"field:person:name": "Ada Google",
					"field:person:emails": ["ADA@example.com"],
				},
			}],
		};
		assert.deepEqual(entities.upsertProjectionBatch(google), { changed: 1 });
		assert.deepEqual(entities.upsertProjectionBatch(google), { changed: 0 });
		const entityId = String(
			database.prepare("SELECT entity_id FROM source_observations").get()
				?.entity_id,
		);
		const github = {
			provider: "github",
			connectionId: "account-b",
			provenance,
			records: [{
				resourceType: "user",
				resourceId: "1",
				sourceRevision: "1",
				tagId: INTEGRATION_TAGS.githubUser,
				label: "octo-ada",
				values: {
					"field:person:name": "Ada GitHub",
					"field:person:emails": ["ada@example.com", "other@example.com"],
				},
			}],
		};
		// A projection creates a distinct canonical entity until an explicit merge.
		entities.upsertProjectionBatch(github);
		const githubId = String(
			database.prepare(
				"SELECT entity_id FROM source_observations WHERE provider = 'github'",
			).get()?.entity_id,
		);
		const preferred = entities.setPreferredSource(
			githubId,
			"field:person:name",
			{
				provider: "github",
				connectionId: "account-b",
				resourceType: "user",
				resourceId: "1",
			},
			1,
			provenance,
		);
		assert.equal(preferred.ok, true);
		entities.mergeEntities(githubId, entityId, 2, 1, provenance);
		assert.equal(
			entities.getEntity(entityId)?.values["field:person:name"],
			"Ada GitHub",
		);
		assert.deepEqual(
			entities.getEntity(entityId)?.values["field:person:emails"],
			["ada@example.com", "other@example.com"],
		);
		entities.setUserValues(
			entityId,
			{ "field:person:name": "Countess Lovelace" },
			[],
			2,
			provenance,
		);
		assert.equal(
			entities.getEntity(entityId)?.values["field:person:name"],
			"Countess Lovelace",
		);
		assert.equal(entities.getEntity(entityId)?.label, "Countess Lovelace");
		assert.deepEqual(
			entities.upsertProjectionBatch({
				...google,
				records: [{
					...google.records[0],
					sourceRevision: "2",
					label: "Augusta Ada King",
					values: { "field:person:name": "Augusta Ada King" },
				}],
			}),
			{ changed: 1 },
		);
		assert.equal(entities.getEntity(entityId)?.label, "Countess Lovelace");
		assert.deepEqual(
			entities.upsertProjectionBatch({
				...google,
				records: [{
					resourceType: "contact",
					resourceId: "people/1",
					sourceRevision: "3",
					tagId: INTEGRATION_TAGS.googleContact,
					deleted: true,
				}],
			}),
			{ changed: 1 },
		);
		assert.equal(entities.getEntity(entityId)?.label, "Countess Lovelace");
	} finally {
		database.close();
	}
});

Deno.test("tombstones scrub source data and hide source-only entities until reactivation", () => {
	const { database, entities } = fixture();
	try {
		const active = {
			provider: "google",
			connectionId: "account-a",
			provenance,
			records: [{
				resourceType: "contact",
				resourceId: "people/private",
				sourceRevision: "1",
				tagId: INTEGRATION_TAGS.googleContact,
				label: "Private Person",
				aliases: ["private@example.com"],
				values: {
					"field:person:name": "Private Person",
					"field:person:emails": ["private@example.com"],
				},
			}],
		};
		entities.upsertProjectionBatch(active);
		const entityId = String(
			database.prepare("SELECT entity_id FROM source_observations").get()
				?.entity_id,
		);
		assert.deepEqual(entities.getEntitySources(entityId), [{
			provider: "google",
			connectionId: "account-a",
			resourceType: "contact",
			resourceId: "people/private",
		}]);
		entities.upsertProjectionBatch({
			...active,
			records: [{
				resourceType: "contact",
				resourceId: "people/private",
				sourceRevision: "deleted:1",
				tagId: INTEGRATION_TAGS.googleContact,
				deleted: true,
			}],
		});
		assert.deepEqual(entities.getEntitySources(entityId), []);
		assert.deepEqual(entities.searchEntities("private"), []);
		assert.equal(entities.getEntity(entityId)?.archived, true);
		assert.deepEqual(entities.getEntity(entityId)?.tagIds, [BASE_TAGS.person]);
		const scrubbed = database.prepare(
			'SELECT label, "values" FROM source_observations',
		).get();
		assert.equal(scrubbed?.label, "");
		assert.equal(scrubbed?.values, "{}");
		assert.equal(
			database.prepare("SELECT count(*) AS count FROM source_aliases").get()
				?.count,
			0,
		);
		assert.equal(
			database.prepare("SELECT label FROM entities").get()?.label,
			"Deleted Person",
		);

		entities.upsertProjectionBatch({
			...active,
			records: [{ ...active.records[0], sourceRevision: "2" }],
		});
		assert.equal(entities.getEntity(entityId)?.archived, false);
		assert.equal(entities.searchEntities("private")[0]?.id, entityId);
		assert.ok(
			entities.getEntity(entityId)?.tagIds.includes(
				INTEGRATION_TAGS.googleContact,
			),
		);
	} finally {
		database.close();
	}
});

Deno.test("merges retain redirects and every mutation has provenance", () => {
	const { database, entities } = fixture();
	try {
		const left = entities.createEntity({
			label: "Ada",
			tagIds: [BASE_TAGS.person],
			values: { "field:person:name": "Ada" },
			aliases: ["A. Lovelace"],
		}, provenance);
		const right = entities.createEntity({
			label: "Lovelace",
			tagIds: [BASE_TAGS.person],
			values: { "field:person:name": "Lovelace" },
		}, provenance);
		const staleMerge = entities.mergeEntities(
			left.id,
			right.id,
			2,
			1,
			provenance,
		);
		assert.deepEqual(staleMerge.conflicts, [{
			entityId: left.id,
			expectedRevision: 2,
			actualRevision: 1,
		}]);
		assert.equal(entities.getEntity(left.id)?.redirectedTo, undefined);
		const merged = entities.mergeEntities(left.id, right.id, 1, 1, provenance);
		assert.equal(merged.ok, true);
		assert.equal(merged.entity.id, right.id);
		assert.equal(merged.entity.redirectedTo, right.id);
		assert.deepEqual(merged.entity.aliases, ["A. Lovelace"]);
		assert.deepEqual(merged.entity.mergedEntityIds, [right.id, left.id]);
		assert.deepEqual(merged.entity.bodyDocumentIds, [
			right.bodyDocumentId,
			left.bodyDocumentId,
		]);
		const conflict = entities.setUserValues(
			right.id,
			{ "field:person:name": "Stale" },
			[],
			1,
			provenance,
		);
		assert.deepEqual(conflict.conflicts, [{
			entityId: right.id,
			expectedRevision: 1,
			actualRevision: 2,
		}]);
		assert.equal(conflict.entity.values["field:person:name"], "Lovelace");
		assert.ok(
			Number(
				database.prepare("SELECT count(*) AS count FROM audit_events").get()
					?.count,
			) >= 4,
		);
		assert.equal(
			database.prepare(
				"SELECT count(*) AS count FROM audit_events WHERE actor = '' OR cause = '' OR rationale = ''",
			).get()?.count,
			0,
		);
	} finally {
		database.close();
	}
});

Deno.test("Supertag management reports inherited origins and archives with reviewed impact", () => {
	const { database, entities } = fixture();
	try {
		const role = entities.createUserTag({
			name: "Professional",
			parentId: BASE_TAGS.person,
		}, provenance);
		const engineer = entities.createUserTag({
			name: "Engineer",
			parentId: role.id,
		}, provenance);
		const specialty = entities.defineField({
			tagId: role.id,
			key: "specialty",
			label: "Specialty",
			type: "text",
			cardinality: "single",
		}, provenance);
		entities.createEntity({
			label: "Ada",
			tagIds: [engineer.id],
			values: { [specialty.id]: "Computing" },
		}, provenance);
		const details = entities.getTag(engineer.id)!;
		assert.equal(details.directEntityCount, 1);
		assert.equal(
			details.fields.find((field) => field.id === specialty.id)?.originTagId,
			role.id,
		);
		assert.equal(
			details.fields.find((field) => field.id === specialty.id)?.inherited,
			true,
		);
		assert.deepEqual(entities.getTagArchiveImpact(role.id), {
			allowed: false,
			entityCount: 1,
			descendantTagCount: 1,
			valueCount: 1,
		});
		assert.deepEqual(entities.getFieldArchiveImpact(specialty.id), {
			allowed: true,
			entityCount: 1,
			descendantTagCount: 1,
			valueCount: 1,
		});
		assert.throws(() =>
			entities.renameUserTag(BASE_TAGS.person, "People", 1, provenance)
		);
		assert.throws(() =>
			entities.archiveUserTag(INTEGRATION_TAGS.googleContact, 1, provenance)
		);
		const renamed = entities.renameUserTag(
			role.id,
			"Technologist",
			2,
			provenance,
		);
		assert.equal(renamed.tag.name, "Technologist");
		assert.equal(renamed.tag.revision, 3);
		assert.throws(() => entities.archiveField(specialty.id, 3, 0, provenance));
		const archivedField = entities.archiveField(specialty.id, 3, 1, provenance);
		assert.equal(archivedField.tag.revision, 4);
		assert.equal(
			archivedField.fields.find((field) => field.id === specialty.id)?.archived,
			true,
		);
		const unused = entities.createUserTag({
			name: "Unused",
			parentId: BASE_TAGS.topic,
		}, provenance);
		const archivedTag = entities.archiveUserTag(unused.id, 1, provenance);
		assert.equal(archivedTag.tag.archived, true);
		assert.ok(
			Number(
				database.prepare(
					"SELECT count(*) AS count FROM audit_events WHERE subject_type IN ('supertag','field-definition')",
				).get()?.count,
			) >= 8,
		);
	} finally {
		database.close();
	}
});

Deno.test("tasks are canonical entities with durable idempotent creation and revision conflicts", () => {
	const { database, entities } = fixture();
	try {
		const input = {
			requestId: "abcdefab-1234-4234-8234-abcdefabcdef",
			title: "Ship voice",
			dueDate: "2026-09-14",
			priority: "high" as const,
		};
		const created = entities.createTask(input, provenance);
		assert.equal(created.ok, true);
		if (!created.ok) throw new Error("creation failed");
		assert.equal(
			entities.getEntity(created.task.id)?.values["field:task:due_date"],
			"2026-09-14",
		);
		assert.equal(created.task.status, "open");
		const completed = entities.updateTask(created.task.id, {
			expectedRevision: 1,
			status: "completed",
		}, provenance);
		assert.equal(completed.ok, true);
		const replay = entities.createTask(input, provenance);
		assert.equal(replay.ok, true);
		if (replay.ok) {
			assert.equal(replay.task.status, "completed");
			assert.equal(replay.task.revision, 2);
		}
		assert.equal(entities.listTasks().tasks.length, 1);
		assert.equal(
			entities.createTask({ ...input, title: "Different payload" }, provenance)
				.ok,
			false,
		);
		const conflict = entities.updateTask(created.task.id, {
			expectedRevision: 1,
			title: "stale",
		}, provenance);
		assert.equal(conflict.ok, false);
		if (!conflict.ok) {
			assert.equal(conflict.error, "conflict");
			assert.equal(conflict.task?.title, "Ship voice");
		}
		const reopened = entities.updateTask(created.task.id, {
			expectedRevision: 2,
			status: "open",
			dueDate: null,
		}, provenance);
		assert.equal(reopened.ok, true);
		if (reopened.ok) {
			assert.equal(reopened.task.dueDate, null);
			assert.equal(reopened.task.status, "open");
		}
	} finally {
		database.close();
	}
});

Deno.test("tasks exclude imported entities and enforce owner-local references and valid dates", () => {
	const { database, entities } = fixture();
	try {
		const imported = entities.createEntity({
			label: "GitHub item",
			tagIds: [INTEGRATION_TAGS.githubIssue],
		}, provenance);
		assert.equal(entities.getTask(imported.id), null);
		assert.deepEqual(entities.listTasks().tasks, []);
		assert.equal(
			entities.updateTask(imported.id, {
				expectedRevision: 1,
				status: "completed",
			}, provenance).ok,
			false,
		);
		const requestId = "abcdefab-1234-4234-8234-abcdefabcdef";
		for (
			const dueDate of ["2026-02-30", "2025-02-29", "0000-01-01", "2026-9-1"]
		) {
			assert.throws(() =>
				entities.createTask(
					{ requestId, title: "Invalid", dueDate },
					provenance,
				)
			);
		}
		assert.throws(() =>
			entities.createTask({
				requestId,
				title: "Missing link",
				linkedEntityIds: ["bbbbbbbb-1234-4234-8234-abcdefabcdef"],
			}, provenance)
		);
		assert.throws(() =>
			entities.createTask({
				requestId,
				title: "Wrong project",
				projectId: imported.id,
			}, provenance)
		);
		assert.equal(entities.getEntity(requestId), null);
		const project = entities.createEntity({
			label: "Launch",
			tagIds: [BASE_TAGS.project],
		}, provenance);
		const result = entities.createTask({
			requestId,
			title: "Ship",
			dueDate: "2028-02-29",
			projectId: project.id,
			linkedEntityIds: [imported.id],
		}, provenance);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.task.projectId, project.id);
			assert.deepEqual(result.task.linkedEntityIds, [imported.id]);
		}
	} finally {
		database.close();
	}
});

Deno.test("task pages preserve every task and receipts survive store restart", () => {
	const { database, entities } = fixture();
	try {
		for (let i = 1; i <= 3; i++) {
			entities.createTask({
				requestId: `abcdefab-1234-4234-8234-${String(i).padStart(12, "0")}`,
				title: `Task ${i}`,
			}, provenance);
		}
		const page1 = entities.listTasks({ limit: 2 });
		assert.equal(page1.tasks.length, 2);
		assert.ok(page1.nextCursor);
		const page2 = entities.listTasks({ limit: 2, cursor: page1.nextCursor });
		assert.equal(page2.tasks.length, 1);
		assert.equal(page2.nextCursor, null);
		const restarted = createEntityStore(
			drizzle({ client: database }) as unknown as EntityDatabase,
		);
		const replay = restarted.createTask({
			requestId: page1.tasks[0].id,
			title: "Task 1",
		}, provenance);
		assert.equal(replay.ok, true);
		assert.equal(restarted.listTasks().tasks.length, 3);
	} finally {
		database.close();
	}
});

Deno.test("task request IDs and entity links stay isolated between owner stores", () => {
	const alice = fixture(), bob = fixture();
	try {
		const requestId = "abcdefab-1234-4234-8234-abcdefabcdef";
		alice.entities.createTask({ requestId, title: "Alice task" }, provenance);
		assert.equal(bob.entities.getTask(requestId), null);
		assert.throws(() =>
			bob.entities.createTask({
				requestId,
				title: "Bob task",
				linkedEntityIds: [requestId],
			}, provenance)
		);
		const own = bob.entities.createTask(
			{ requestId, title: "Bob task" },
			provenance,
		);
		assert.equal(own.ok, true);
		if (own.ok) assert.equal(own.task.title, "Bob task");
		assert.equal(alice.entities.getTask(requestId)?.title, "Alice task");
	} finally {
		alice.database.close();
		bob.database.close();
	}
});

Deno.test("field metadata updates require defining user tag and atomic schema revision", () => {
	const { database, entities } = fixture();
	try {
		const tag = entities.createUserTag({
			name: "Action",
			parentId: BASE_TAGS.task,
		}, provenance);
		const field = entities.defineField({
			tagId: tag.id,
			expectedTagRevision: 1,
			key: "stage",
			label: "Stage",
			type: "enum",
			cardinality: "single",
			options: ["planned", "doing"],
			defaultValue: "planned",
		}, provenance);
		assert.throws(
			() =>
				entities.defineField({
					tagId: tag.id,
					expectedTagRevision: 1,
					key: "other",
					label: "Other",
					type: "text",
					cardinality: "single",
				}, provenance),
			/revision conflict/,
		);
		assert.equal(
			entities.getTag(tag.id)?.fields.filter((x) => x.key === "other").length,
			0,
		);
		const child = entities.createUserTag(
			{ name: "Child", parentId: tag.id },
			provenance,
		);
		assert.throws(
			() =>
				entities.updateField({
					id: field.id,
					tagId: child.id,
					expectedTagRevision: 1,
					label: "Wrong",
				}, provenance),
			/Inherited/,
		);
		assert.throws(
			() =>
				entities.updateField({
					id: "field:task:title",
					tagId: BASE_TAGS.task,
					expectedTagRevision: 1,
					label: "Wrong",
				}, provenance),
			/active user fields/,
		);
		assert.throws(
			() =>
				entities.updateField({
					id: field.id,
					tagId: tag.id,
					expectedTagRevision: 1,
					label: "Stale",
				}, provenance),
			/revision conflict/,
		);
		assert.throws(
			() =>
				entities.updateField(
					{
						id: field.id,
						tagId: tag.id,
						expectedTagRevision: 2,
						label: "Rename",
						type: "number",
					} as never,
					provenance,
				),
			/Invalid field update/,
		);
		const updated = entities.updateField({
			id: field.id,
			tagId: tag.id,
			expectedTagRevision: 2,
			label: "Workflow stage",
			options: ["planned", "doing", "done"],
		}, provenance);
		assert.equal(updated.label, "Workflow stage");
		assert.equal(updated.key, "stage");
		assert.equal(updated.type, "enum");
		assert.equal(updated.defaultValue, "planned");
		assert.equal(entities.getTag(tag.id)?.tag.revision, 3);
		assert.equal(
			entities.getTag(child.id)?.fields.find((x) => x.id === field.id)?.label,
			"Workflow stage",
		);
	} finally {
		database.close();
	}
});

Deno.test("field option updates preserve stored values and validate retained defaults", () => {
	const { database, entities } = fixture();
	try {
		const tag = entities.createUserTag({
			name: "Work",
			parentId: BASE_TAGS.task,
		}, provenance);
		const field = entities.defineField({
			tagId: tag.id,
			key: "stage",
			label: "Stage",
			type: "enum",
			cardinality: "single",
			options: ["planned", "doing"],
			defaultValue: "planned",
		}, provenance);
		const entity = entities.createEntity({
			label: "Ship",
			tagIds: [tag.id],
			values: { [field.id]: "doing" },
		}, provenance);
		assert.throws(
			() =>
				entities.updateField({
					id: field.id,
					tagId: tag.id,
					expectedTagRevision: 2,
					options: ["doing"],
				}, provenance),
			/enum option/,
		);
		assert.throws(
			() =>
				entities.updateField({
					id: field.id,
					tagId: tag.id,
					expectedTagRevision: 2,
					options: ["planned"],
				}, provenance),
			/enum option/,
		);
		assert.equal(entities.getTag(tag.id)?.tag.revision, 2);
		assert.equal(entities.getEntity(entity.id)?.values[field.id], "doing");
		const updated = entities.updateField({
			id: field.id,
			tagId: tag.id,
			expectedTagRevision: 2,
			options: ["doing", "done"],
			defaultValue: "doing",
		}, provenance);
		assert.equal(updated.defaultValue, "doing");
		assert.equal(entities.getEntity(entity.id)?.values[field.id], "doing");
	} finally {
		database.close();
	}
});

Deno.test("required field changes check descendants and default removal rolls back safely", () => {
	const { database, entities } = fixture();
	try {
		const tag = entities.createUserTag({
			name: "Work",
			parentId: BASE_TAGS.task,
		}, provenance);
		const child = entities.createUserTag({
			name: "Project action",
			parentId: tag.id,
		}, provenance);
		const field = entities.defineField({
			tagId: tag.id,
			key: "estimate",
			label: "Estimate",
			type: "number",
			cardinality: "single",
		}, provenance);
		const entity = entities.createEntity(
			{ label: "Ship", tagIds: [child.id] },
			provenance,
		);
		assert.throws(
			() =>
				entities.updateField({
					id: field.id,
					tagId: tag.id,
					expectedTagRevision: 2,
					required: true,
				}, provenance),
			/Required field/,
		);
		assert.equal(entities.getTag(tag.id)?.tag.revision, 2);
		assert.equal(
			entities.getTag(tag.id)?.fields.find((x) => x.id === field.id)?.required,
			false,
		);
		entities.updateField({
			id: field.id,
			tagId: tag.id,
			expectedTagRevision: 2,
			required: true,
			defaultValue: 1,
		}, provenance);
		assert.equal(entities.getEntity(entity.id)?.values[field.id], 1);
		assert.throws(
			() =>
				entities.updateField({
					id: field.id,
					tagId: tag.id,
					expectedTagRevision: 3,
					defaultValue: null,
				}, provenance),
			/Required field/,
		);
		assert.equal(entities.getEntity(entity.id)?.values[field.id], 1);
		entities.updateField({
			id: field.id,
			tagId: tag.id,
			expectedTagRevision: 3,
			required: false,
			defaultValue: null,
		}, provenance);
		assert.equal(entities.getEntity(entity.id)?.values[field.id], undefined);
	} finally {
		database.close();
	}
});

import { strict as assert } from "node:assert";
import {
	createTaskComposer,
	taskReference,
} from "../src/editor/taskComposer.ts";
import { parseEntity, parseNote } from "@e2/documents/note";
const requestId = "11111111-1111-4111-8111-111111111111";
const fields = { title: "Plan tomorrow", dueDate: "2026-09-14" };
const task = {
	id: requestId,
	...fields,
	status: "open",
	priority: "none",
	projectId: null,
	linkedEntityIds: [],
	revision: 1,
	bodyDocumentId: `entity:${requestId}`,
};
Deno.test("opening or cancelling a task composer never calls the API", () => {
	let requests = 0;
	const composer = createTaskComposer({
		requestId,
		fetch: () => {
			requests++;
			throw new Error("Must not dispatch");
		},
	});
	assert.equal(composer.locked, false);
	assert.equal(requests, 0);
});
Deno.test("lost task response retries frozen payload and request identity exactly once per attempt", async () => {
	const bodies: string[] = [];
	const composer = createTaskComposer({
		requestId,
		fetch: (_url, options) => {
			bodies.push(String(options?.body));
			if (bodies.length === 1) {
				return Promise.reject(new Error("Lost response"));
			}
			return Promise.resolve(Response.json({ task }));
		},
	});
	await assert.rejects(() => composer.submit(fields), /Could not confirm/);
	assert.equal(composer.locked, true);
	const saved = await composer.submit({
		title: "Changed draft must not replay differently",
		dueDate: null,
	});
	assert.equal(saved.id, requestId);
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0], bodies[1]);
	assert.equal(JSON.parse(bodies[1]).title, fields.title);
	await composer.submit(fields);
	assert.equal(bodies.length, 2);
	assert.deepEqual(parseEntity(taskReference(saved)), taskReference(saved));
});
Deno.test("task composer rejects foreign successful receipt without producing a note link", async () => {
	const composer = createTaskComposer({
		requestId,
		fetch: () =>
			Promise.resolve(
				Response.json({
					task: { ...task, id: "22222222-2222-4222-8222-222222222222" },
				}),
			),
	});
	await assert.rejects(() => composer.submit(fields), /Could not confirm/);
});
Deno.test("daily-note task request persists canonical task exposed by list API and canonical note link", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { drizzle } = await import("drizzle-orm/node-sqlite");
	const { migrate } = await import("drizzle-orm/node-sqlite/migrator");
	const { fileURLToPath } = await import("node:url");
	const { createEntityStore } = await import(
		"../../core/entities/src/storage.ts"
	);
	const { handleTasksRequest } = await import("../src/lib/tasks.ts");
	const database = new DatabaseSync(":memory:");
	try {
		const db = drizzle({ client: database });
		migrate(db, {
			migrationsFolder: fileURLToPath(
				new URL("../../core/entities/migrations", import.meta.url),
			),
		});
		const store = createEntityStore(
			db as unknown as import("../../core/entities/src/storage.ts").EntityDatabase,
		);
		const api = {
			createTask: (...args: Parameters<typeof store.createTask>) =>
				Promise.resolve(store.createTask(...args)),
			listTasks: (...args: Parameters<typeof store.listTasks>) =>
				Promise.resolve(store.listTasks(...args)),
			getTask: (...args: Parameters<typeof store.getTask>) =>
				Promise.resolve(store.getTask(...args)),
			updateTask: (...args: Parameters<typeof store.updateTask>) =>
				Promise.resolve(store.updateTask(...args)),
		};
		const composer = createTaskComposer({
			requestId,
			fetch: (url, init) =>
				handleTasksRequest(
					new Request(new URL(String(url), "https://example.com"), init),
					api,
					"access:alice",
				),
		});
		const created = await composer.submit(fields);
		const list = await handleTasksRequest(
			new Request("https://example.com/api/tasks"),
			api,
			"access:alice",
		);
		assert.equal(
			(await list.json() as { tasks: { id: string }[] }).tasks[0].id,
			created.id,
		);
		assert.equal(store.getTask(created.id)?.dueDate, "2026-09-14");
		const note = parseNote({
			type: "doc",
			content: [{
				type: "paragraph",
				content: [{
					type: "entity",
					attrs: { entity: taskReference(created) },
				}],
			}],
		});
		assert.ok(JSON.stringify(note).includes(created.id));
	} finally {
		database.close();
	}
});

Deno.test("task dialog freeze and cancelled restore do not emit Tiptap updates or save a lazy note", async () => {
	const { Editor } = await import("@tiptap/core");
	const { setTaskEditorEditable } = await import(
		"../src/editor/taskComposer.ts"
	);
	let updates = 0;
	let editable = true;
	// Exercise Tiptap's actual update-emitting implementation, without requiring a
	// browser DOM. Fieldnotes uses this boundary for open, cancel and completion.
	const boundary = {
		setOptions: (options: { editable: boolean }) => {
			editable = options.editable;
		},
		emit: () => {
			updates++;
		},
		state: { tr: {} },
	};
	const editor = {
		setEditable: (value: boolean, emitUpdate?: boolean) =>
			Editor.prototype.setEditable.call(
				boundary as unknown as InstanceType<typeof Editor>,
				value,
				emitUpdate,
			),
	};
	setTaskEditorEditable(editor, false);
	assert.equal(editable, false);
	setTaskEditorEditable(editor, true);
	assert.equal(editable, true);
	assert.equal(updates, 0);
	// Positive control: the default API is observable, the source of the regression.
	editor.setEditable(false);
	assert.equal(updates, 1);
});

import { strict as assert } from "node:assert";
import { handleTasksRequest } from "../src/lib/tasks.ts";
import type { Task, TasksApi } from "@enchiridion/entities";
const task: Task = {
	id: "abcdefab-1234-4234-8234-abcdefabcdef",
	title: "Ship",
	status: "open",
	dueDate: null,
	priority: "none",
	projectId: null,
	linkedEntityIds: [],
	revision: 1,
	bodyDocumentId: "entity:abcdefab-1234-4234-8234-abcdefabcdef",
};
const fixture = () => {
	const calls: unknown[] = [];
	const api: TasksApi = {
		listTasks: (options) => {
			calls.push(options);
			return Promise.resolve({ tasks: [task], nextCursor: null });
		},
		getTask: (id) => Promise.resolve(id === task.id ? task : null),
		createTask: (input, provenance) => {
			calls.push({ input, provenance });
			return Promise.resolve({ ok: true, task });
		},
		updateTask: (_id, input, provenance) => {
			calls.push({ input, provenance });
			return Promise.resolve(
				input.expectedRevision === 1
					? {
						ok: true,
						task: { ...task, status: input.status ?? task.status, revision: 2 },
					}
					: { ok: false, error: "conflict", task },
			);
		},
	};
	return { calls, api };
};
const request = (body: unknown) =>
	new Request("https://example.com/api/tasks", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
Deno.test("task HTTP writes use authenticated owner provenance and return current conflicts", async () => {
	const { api, calls } = fixture();
	const response = await handleTasksRequest(
		request({ requestId: task.id, title: " Ship " }),
		api,
		"access:alice",
	);
	assert.equal(response.status, 200);
	assert.equal((await response.json() as { task: Task }).task.id, task.id);
	assert.deepEqual(calls[0], {
		input: {
			requestId: task.id,
			title: "Ship",
			dueDate: null,
			priority: "none",
			projectId: null,
			linkedEntityIds: [],
		},
		provenance: {
			actor: "access:alice",
			cause: "tasks-ui",
			rationale: "Create task requested by owner",
		},
	});
	const conflict = await handleTasksRequest(
		request({ expectedRevision: 2, status: "completed" }),
		api,
		"access:alice",
		task.id,
	);
	assert.equal(conflict.status, 409);
	assert.deepEqual(await conflict.json(), { error: "conflict", task });
});
Deno.test("task HTTP rejects malformed or excessive input before RPC", async () => {
	const { api, calls } = fixture();
	for (
		const body of [
			{ requestId: task.id, title: "Ship", ownerId: "victim" },
			{ requestId: task.id, title: "Ship", dueDate: "2026-02-30" },
			{ requestId: task.id, title: "x".repeat(9000) },
			{ requestId: task.id, title: "Ship", priority: "urgent" },
		]
	) {
		assert.equal(
			(await handleTasksRequest(request(body), api, "access:alice")).status,
			400,
		);
	}
	assert.equal(
		(await handleTasksRequest(
			new Request("https://example.com/api/tasks?limit=101"),
			api,
			"access:alice",
		)).status,
		400,
	);
	assert.equal(
		(await handleTasksRequest(
			new Request("https://example.com/api/tasks?cursor=bad"),
			api,
			"access:alice",
		)).status,
		400,
	);
	assert.equal(calls.length, 0);
});
Deno.test("task HTTP reads pagination and reports missing task", async () => {
	const { api, calls } = fixture();
	const response = await handleTasksRequest(
		new Request(`https://example.com/api/tasks?cursor=${task.id}&limit=20`),
		api,
		"access:alice",
	);
	assert.equal(response.status, 200);
	assert.deepEqual(calls[0], { cursor: task.id, limit: 20 });
	assert.equal(
		(await handleTasksRequest(
			new Request("https://example.com/api/tasks"),
			api,
			"access:alice",
			"bbbbbbbb-1234-4234-8234-abcdefabcdef",
		)).status,
		404,
	);
});

Deno.test("task routes retain their owner RPC until the handler completes", async () => {
	// Route imports bind Cloudflare runtime globals; assert the lifetime boundary
	// in their source and exercise that same explicit-resource-management pattern.
	for (
		const file of [
			"../src/pages/api/tasks/index.ts",
			"../src/pages/api/tasks/[id].ts",
		]
	) {
		const source = await Deno.readTextFile(new URL(file, import.meta.url));
		assert.match(source, /return await handleTasksRequest\(/);
	}
	const events: string[] = [];
	let finish!: () => void;
	const ready = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const scoped = async () => {
		using rpc = {
			[Symbol.dispose]: () => {
				events.push("disposed");
			},
			read: async () => {
				await ready;
				events.push("completed");
			},
		};
		return await rpc.read();
	};
	const pending = scoped();
	assert.deepEqual(events, []);
	finish();
	await pending;
	assert.deepEqual(events, ["completed", "disposed"]);
});

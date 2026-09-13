import type { VoiceSchemaApi } from "../src/schema-tools.ts";
import { strict as assert } from "node:assert";
import { createVoiceTaskTools } from "../src/task-tools.ts";
import type { TasksApi } from "../../../packages/entities/src/tasks.ts";
const id = "11111111-1111-4111-8111-111111111111";
const task = {
	id,
	title: "Plan launch",
	status: "open" as const,
	dueDate: null,
	priority: "none" as const,
	projectId: null,
	linkedEntityIds: [],
	revision: 1,
	bodyDocumentId: "entity:launch",
};
const context = { toolCallId: "test", messages: [], context: {} };
const setup = (
	overrides: Partial<TasksApi> = {},
	check: () => Promise<void> = () => Promise.resolve(),
) => {
	const calls: unknown[] = [];
	const api: TasksApi & VoiceSchemaApi & Disposable = {
		[Symbol.dispose]() {},
		getTag: () => Promise.resolve(null),
		defineField: () => Promise.reject(new Error("Unused")),
		updateField: () => Promise.reject(new Error("Unused")),
		listTasks: () =>
			Promise.resolve({
				tasks: [{ ...task, credential: "private" }],
				nextCursor: null,
			}),
		getTask: () => Promise.resolve(task),
		createTask: (input, provenance) => {
			calls.push({ input, provenance });
			return Promise.resolve({ ok: true, task });
		},
		updateTask: () => Promise.resolve({ ok: false, error: "conflict", task }),
		...overrides,
	};
	return {
		calls,
		tools: createVoiceTaskTools({
			owner: "access:alice",
			signal: new AbortController().signal,
			isCurrent: () => Promise.resolve(true),
			check,
			binding: {
				admin: (owner) => {
					assert.equal(owner, "access:alice");
					return Promise.resolve(api);
				},
			},
		}),
	};
};
Deno.test("voice task mutations carry host provenance and generated request identity", async () => {
	const { tools, calls } = setup();
	const result = await tools.taskCreate.execute!(
		{ title: "Plan launch" },
		context,
	);
	assert.equal((result as { result: { ok: boolean } }).result.ok, true);
	const call = calls[0] as {
		input: { requestId: string };
		provenance: { actor: string };
	};
	assert.match(call.input.requestId, /^[0-9a-f-]{36}$/);
	assert.equal(call.provenance.actor, "access:alice");
	assert.equal(calls.length, 1);
});
Deno.test("voice task reads strip extra sensitive fields", async () => {
	const { tools } = setup();
	const result = await tools.taskList.execute!({}, context);
	assert.equal(JSON.stringify(result).includes("credential"), false);
});
Deno.test("voice task conflicts stay conflicts and uncertain writes never retry", async () => {
	let writes = 0;
	const { tools } = setup({
		createTask: () => {
			writes++;
			throw new Error("connection lost");
		},
	});
	const update = await tools.taskUpdate.execute!({
		id,
		expectedRevision: 1,
		status: "completed",
	}, context);
	assert.equal((update as { result: { ok: boolean } }).result.ok, false);
	const create = await tools.taskCreate.execute!({ title: "Plan" }, context);
	assert.equal((create as { outcome: string }).outcome, "unknown");
	assert.equal(writes, 1);
});
Deno.test("voice task permission gate prevents writes", async () => {
	const { tools, calls } = setup(
		{},
		() => Promise.reject(new Error("Revoked")),
	);
	await assert.rejects(
		() =>
			tools.taskCreate.execute!({ title: "Plan" }, context) as Promise<unknown>,
		/Revoked/,
	);
	assert.equal(calls.length, 0);
});

Deno.test("voice task deadline prevents dispatch after delayed admin resolution", async () => {
	let resolveAdmin!: (api: TasksApi & VoiceSchemaApi & Disposable) => void;
	let writes = 0;
	const tools = createVoiceTaskTools({
		owner: "access:alice",
		signal: new AbortController().signal,
		isCurrent: () => Promise.resolve(true),
		check: () => Promise.resolve(),
		timeoutMs: 5,
		binding: {
			admin: () =>
				new Promise((resolve) => {
					resolveAdmin = resolve;
				}),
		},
	});
	const result = await tools.taskCreate.execute!({ title: "Plan" }, context);
	assert.equal((result as { outcome: string }).outcome, "unknown");
	resolveAdmin(
		{
			[Symbol.dispose]() {},
			createTask: () => {
				writes++;
				return Promise.resolve({ ok: true, task });
			},
		} as unknown as TasksApi & VoiceSchemaApi & Disposable,
	);
	await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(writes, 0);
	await assert.rejects(
		() =>
			tools.taskCreate.execute!({ title: "Plan again" }, context) as Promise<
				unknown
			>,
		/uncertain/,
	);
});

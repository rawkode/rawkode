import {
	parseCreateTask,
	parseUpdateTask,
	type TaskMutationResult,
	type TasksApi,
	validTaskId,
} from "@e2/entities";

const readBody = async (request: Request): Promise<unknown> => {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 8192) {
				await reader.cancel();
				throw new Error("Task request too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
};
const mutationResponse = (result: TaskMutationResult) =>
	result.ok
		? Response.json({ task: result.task })
		: Response.json({ error: result.error, task: result.task }, {
			status: result.error === "not_found" ? 404 : 409,
		});
/** The caller supplies the authenticated owner's RPC; identity never comes from JSON. */
export const handleTasksRequest = async (
	request: Request,
	api: TasksApi,
	ownerId: string,
	taskId?: string,
): Promise<Response> => {
	if (taskId !== undefined && !validTaskId(taskId)) {
		return Response.json({ error: "Invalid task ID" }, { status: 400 });
	}
	if (request.method === "GET") {
		if (taskId) {
			const task = await api.getTask(taskId);
			return task
				? Response.json({ task })
				: Response.json({ error: "not_found" }, { status: 404 });
		}
		const query = new URL(request.url).searchParams;
		const cursor = query.get("cursor") ?? undefined,
			limit = Number(query.get("limit") ?? 100);
		if (
			cursor !== undefined && !validTaskId(cursor) ||
			!Number.isSafeInteger(limit) || limit < 1 || limit > 100
		) return Response.json({ error: "Invalid task page" }, { status: 400 });
		return Response.json(await api.listTasks({ cursor, limit }));
	}
	if (request.method !== "POST") {
		return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
	}
	if (
		request.headers.get("Content-Type")?.split(";")[0].trim() !==
			"application/json"
	) return Response.json({ error: "Expected JSON" }, { status: 415 });
	let input;
	try {
		const body = await readBody(request);
		input = taskId ? parseUpdateTask(body) : parseCreateTask(body);
	} catch {
		return Response.json({ error: "Invalid task fields or revision" }, {
			status: 400,
		});
	}
	const provenance = {
		actor: ownerId,
		cause: "tasks-ui",
		rationale: taskId
			? "Update task requested by owner"
			: "Create task requested by owner",
	};
	try {
		return mutationResponse(
			taskId
				? await api.updateTask(taskId, parseUpdateTask(input), provenance)
				: await api.createTask(parseCreateTask(input), provenance),
		);
	} catch (error) {
		// Known validation messages only; operational failures must remain server errors.
		if (
			error instanceof Error &&
			["Linked entity not found", "Project must reference a project entity"]
				.includes(error.message)
		) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
};

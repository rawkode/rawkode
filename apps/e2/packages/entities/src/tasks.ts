import type { MutationProvenance } from "./index.ts";

export type TaskStatus = "open" | "completed";
export type TaskPriority = "none" | "low" | "medium" | "high";
export interface Task {
	id: string;
	title: string;
	status: TaskStatus;
	dueDate: string | null;
	priority: TaskPriority;
	projectId: string | null;
	linkedEntityIds: readonly string[];
	revision: number;
	bodyDocumentId: string;
}
export interface CreateTaskInput {
	requestId: string;
	title: string;
	dueDate?: string | null;
	priority?: TaskPriority;
	projectId?: string | null;
	linkedEntityIds?: readonly string[];
}
export interface UpdateTaskInput {
	expectedRevision: number;
	title?: string;
	status?: TaskStatus;
	dueDate?: string | null;
	priority?: TaskPriority;
	projectId?: string | null;
	linkedEntityIds?: readonly string[];
}
export interface TaskPageOptions {
	cursor?: string;
	limit?: number;
}
export interface TaskPage {
	tasks: readonly Task[];
	nextCursor: string | null;
}
export type TaskMutationResult =
	| { ok: true; task: Task }
	| {
		ok: false;
		error: "conflict" | "request_reused" | "not_found";
		task: Task | null;
	};
export interface TasksApi {
	listTasks(options?: TaskPageOptions): Promise<TaskPage>;
	getTask(id: string): Promise<Task | null>;
	createTask(
		input: CreateTaskInput,
		provenance: MutationProvenance,
	): Promise<TaskMutationResult>;
	updateTask(
		id: string,
		input: UpdateTaskInput,
		provenance: MutationProvenance,
	): Promise<TaskMutationResult>;
}
const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validTaskId = (value: unknown): value is string =>
	typeof value === "string" && uuid.test(value);
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected task object");
	}
	return value as Record<string, unknown>;
};
const validateFields = (body: Record<string, unknown>) => {
	if (
		"title" in body &&
		(typeof body.title !== "string" || !body.title.trim() ||
			body.title.trim().length > 500)
	) throw new Error("Invalid task title");
	if (
		"status" in body && !["open", "completed"].includes(String(body.status))
	) throw new Error("Invalid task status");
	if (
		"priority" in body &&
		!["none", "low", "medium", "high"].includes(String(body.priority))
	) throw new Error("Invalid task priority");
	if ("dueDate" in body && body.dueDate !== null) {
		const date = body.dueDate;
		if (
			typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
			date.startsWith("0000") || !Number.isFinite(Date.parse(date)) ||
			new Date(date).toISOString().slice(0, 10) !== date
		) throw new Error("Invalid task due date");
	}
	if (
		"projectId" in body && body.projectId !== null &&
		!validTaskId(body.projectId)
	) throw new Error("Invalid project ID");
	if (
		"linkedEntityIds" in body &&
		(!Array.isArray(body.linkedEntityIds) || body.linkedEntityIds.length > 32 ||
			!body.linkedEntityIds.every(validTaskId) ||
			new Set(body.linkedEntityIds).size !== body.linkedEntityIds.length)
	) throw new Error("Invalid linked entity IDs");
};
export const parseCreateTask = (value: unknown): CreateTaskInput => {
	const body = record(value);
	if (
		Object.keys(body).some((key) =>
			![
				"requestId",
				"title",
				"dueDate",
				"priority",
				"projectId",
				"linkedEntityIds",
			].includes(key)
		) || !validTaskId(body.requestId) || !("title" in body)
	) throw new Error("Invalid task creation");
	validateFields(body);
	return {
		requestId: body.requestId.toLowerCase(),
		title: (body.title as string).trim(),
		dueDate: body.dueDate as string | null ?? null,
		priority: body.priority as TaskPriority ?? "none",
		projectId: body.projectId as string | null ?? null,
		linkedEntityIds: [...(body.linkedEntityIds as string[] ?? [])].sort(),
	};
};
export const parseUpdateTask = (value: unknown): UpdateTaskInput => {
	const body = record(value);
	if (
		Object.keys(body).some((key) =>
			![
				"expectedRevision",
				"title",
				"status",
				"dueDate",
				"priority",
				"projectId",
				"linkedEntityIds",
			].includes(key)
		) || !Number.isSafeInteger(body.expectedRevision) ||
		Number(body.expectedRevision) < 1 ||
		Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER ||
		Object.keys(body).length < 2
	) throw new Error("Invalid task update or revision");
	validateFields(body);
	return {
		...body,
		...("title" in body ? { title: (body.title as string).trim() } : {}),
	} as unknown as UpdateTaskInput;
};

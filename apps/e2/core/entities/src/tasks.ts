import { and, asc, eq, exists, gt } from "drizzle-orm";
import {
	BASE_TAGS,
	type CanonicalEntity,
	type CreateEntityInput,
	type CreateTaskInput,
	type EntityMutationResult,
	type MutationProvenance,
	parseCreateTask,
	parseUpdateTask,
	type Task,
	type TaskMutationResult,
	type TaskPage,
	type TaskPageOptions,
	type UpdateTaskInput,
	validTaskId,
} from "@e2/entities";
import { auditEvents, entities, entityTags, supertags } from "../schema.ts";
import type { EntityDatabase } from "./storage.ts";

type Executor = Pick<EntityDatabase, "delete" | "insert" | "select" | "update">;
interface Dependencies {
	db: EntityDatabase;
	store: {
		getEntity(id: string): CanonicalEntity | null;
		setUserValues(
			id: string,
			values: Readonly<Record<string, unknown>>,
			clear: readonly string[],
			revision: number,
			provenance: MutationProvenance,
		): EntityMutationResult;
	};
	createEntityRows(
		tx: Executor,
		input: CreateEntityInput,
		provenance: MutationProvenance,
		id: string,
	): string;
	now(): string;
	id(): string;
}
const taskView = (entity: CanonicalEntity): Task => ({
	id: entity.id,
	title: entity.label,
	revision: entity.revision,
	bodyDocumentId: entity.bodyDocumentId,
	status: entity.values["field:task:status"] === "completed"
		? "completed"
		: "open",
	dueDate: typeof entity.values["field:task:due_date"] === "string"
		? entity.values["field:task:due_date"]
		: null,
	priority: ["low", "medium", "high"].includes(
			String(entity.values["field:task:priority"]),
		)
		? entity.values["field:task:priority"] as Task["priority"]
		: "none",
	projectId: typeof entity.values["field:task:project"] === "string"
		? entity.values["field:task:project"]
		: null,
	linkedEntityIds: Array.isArray(entity.values["field:task:links"])
		? entity.values["field:task:links"] as string[]
		: [],
});
const fields = {
	title: "field:task:title",
	status: "field:task:status",
	dueDate: "field:task:due_date",
	priority: "field:task:priority",
	projectId: "field:task:project",
	linkedEntityIds: "field:task:links",
} as const;
export const createTaskStore = (
	{ db, store, createEntityRows, now, id }: Dependencies,
) => {
	const receipt = (requestId: string) =>
		db.select().from(auditEvents).where(
			and(
				eq(auditEvents.subjectType, "task-create"),
				eq(auditEvents.subjectId, requestId),
			),
		).get();
	const getTask = (taskId: string): Task | null => {
		if (!validTaskId(taskId)) throw new Error("Invalid task ID");
		if (!receipt(taskId)) return null;
		const entity = store.getEntity(taskId);
		// Merged or archived entities must not accidentally become mutable task aliases.
		return entity && !entity.archived && entity.id === taskId &&
				entity.tagIds.includes(BASE_TAGS.task)
			? taskView(entity)
			: null;
	};
	const checkLinks = (input: CreateTaskInput | UpdateTaskInput) => {
		for (
			const linkedId of [
				...input.linkedEntityIds ?? [],
				...input.projectId ? [input.projectId] : [],
			]
		) {
			const entity = store.getEntity(linkedId);
			if (!entity || entity.archived) {
				throw new Error("Linked entity not found");
			}
			if (linkedId === input.projectId) {
				const project = db.select({ id: entityTags.entityId }).from(entityTags)
					.innerJoin(supertags, eq(supertags.id, entityTags.tagId)).where(
						and(
							eq(entityTags.entityId, entity.id),
							eq(supertags.rootId, BASE_TAGS.project),
						),
					).get();
				if (!project) {
					throw new Error("Project must reference a project entity");
				}
			}
		}
	};
	const valuesFor = (input: CreateTaskInput | UpdateTaskInput) =>
		Object.fromEntries(
			Object.entries(fields).filter(([key]) =>
				key in input && input[key as keyof typeof input] !== null
			).map(([key, field]) => [field, input[key as keyof typeof input]]),
		);
	return {
		getTask,
		listTasks: (options: TaskPageOptions = {}): TaskPage => {
			const limit = options.limit ?? 100;
			if (
				!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
				options.cursor !== undefined && !validTaskId(options.cursor)
			) throw new Error("Invalid task page");
			const rows = db.select({ id: entities.id }).from(entities).where(and(
				eq(entities.archived, false),
				options.cursor ? gt(entities.id, options.cursor) : undefined,
				exists(
					db.select({ id: auditEvents.id }).from(auditEvents).where(
						and(
							eq(auditEvents.subjectType, "task-create"),
							eq(auditEvents.subjectId, entities.id),
						),
					),
				),
				exists(
					db.select({ id: entityTags.entityId }).from(entityTags).where(
						and(
							eq(entityTags.entityId, entities.id),
							eq(entityTags.tagId, BASE_TAGS.task),
						),
					),
				),
			)).orderBy(asc(entities.id)).limit(limit + 1).all();
			return {
				tasks: rows.slice(0, limit).map((row) =>
					taskView(store.getEntity(row.id)!)
				),
				nextCursor: rows.length > limit ? rows[limit - 1].id : null,
			};
		},
		createTask: (
			raw: CreateTaskInput,
			provenance: MutationProvenance,
		): TaskMutationResult => {
			const input = parseCreateTask(raw);
			return db.transaction((tx) => {
				const existing = receipt(input.requestId),
					fingerprint = JSON.stringify(input);
				if (existing) {
					const task = getTask(input.requestId);
					if (existing.rationale !== fingerprint) {
						return { ok: false, error: "request_reused", task };
					}
					return task
						? { ok: true, task }
						: { ok: false, error: "not_found", task: null };
				}
				if (store.getEntity(input.requestId)) {
					return { ok: false, error: "request_reused", task: null };
				}
				checkLinks(input);
				createEntityRows(
					tx,
					{
						label: input.title,
						tagIds: [BASE_TAGS.task],
						values: { ...valuesFor(input), [fields.status]: "open" },
					},
					provenance,
					input.requestId,
				);
				tx.insert(auditEvents).values({
					id: id(),
					subjectType: "task-create",
					subjectId: input.requestId,
					revision: 1,
					actor: provenance.actor,
					cause: provenance.cause,
					rationale: fingerprint,
					createdAt: now(),
				}).run();
				return { ok: true, task: getTask(input.requestId)! };
			});
		},
		updateTask: (
			taskId: string,
			raw: UpdateTaskInput,
			provenance: MutationProvenance,
		): TaskMutationResult => {
			const input = parseUpdateTask(raw), current = getTask(taskId);
			if (!current) return { ok: false, error: "not_found", task: null };
			if (current.revision !== input.expectedRevision) {
				return { ok: false, error: "conflict", task: current };
			}
			checkLinks(input);
			const clear = Object.entries(fields).filter(([key]) =>
				key in input && input[key as keyof typeof input] === null
			).map(([, field]) => field);
			const result = store.setUserValues(
				taskId,
				valuesFor(input),
				clear,
				input.expectedRevision,
				provenance,
			);
			return result.ok
				? { ok: true, task: taskView(result.entity) }
				: { ok: false, error: "conflict", task: taskView(result.entity) };
		},
	};
};

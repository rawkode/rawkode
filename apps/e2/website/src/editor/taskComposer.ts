import type { Editor } from "@tiptap/core";
import {
	type CreateTaskInput,
	parseCreateTask,
	type Task,
} from "../../../packages/entities/src/tasks.ts";
import { z } from "zod";
import type { CanonicalEntityReference } from "@e2/documents/note";
const taskSchema = z.object({
	id: z.uuid(),
	title: z.string().min(1).max(500),
	status: z.enum(["open", "completed"]),
	dueDate: z.string().nullable(),
	priority: z.enum(["none", "low", "medium", "high"]),
	projectId: z.string().nullable(),
	linkedEntityIds: z.array(z.string()),
	revision: z.number().int().min(1),
	bodyDocumentId: z.string(),
});
export const taskReference = (
	task: Pick<Task, "id" | "title">,
): CanonicalEntityReference => ({
	version: 1,
	entityId: task.id,
	fallbackLabel: task.title,
	displayText: task.title,
	presentation: "link",
});
/** One dialog owns one immutable request identity, including after a lost reply. */
export const createTaskComposer = (
	options: { requestId?: string; fetch?: typeof fetch; timeoutMs?: number } =
		{},
) => {
	const requestId = options.requestId ?? crypto.randomUUID();
	let submitted: CreateTaskInput | undefined;
	let pending: Promise<Task> | undefined;
	let saved: Task | undefined;
	return {
		get locked() {
			return !!submitted;
		},
		submit(fields: { title: string; dueDate: string | null }): Promise<Task> {
			if (saved) return Promise.resolve(saved);
			if (pending) return pending;
			submitted ??= parseCreateTask({ requestId, ...fields });
			const controller = new AbortController();
			pending = (async () => {
				const timer = setTimeout(
					() => controller.abort(),
					options.timeoutMs ?? 12000,
				);
				try {
					const response = await (options.fetch ?? fetch)("/api/tasks", {
						method: "POST",
						credentials: "same-origin",
						redirect: "error",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(submitted),
						signal: controller.signal,
					});
					if (!response.ok) {
						await response.body?.cancel();
						throw new Error(
							response.status === 409
								? "This task request conflicts with an existing task. Your note is unchanged."
								: "Could not confirm this task was saved. Check Tasks or try again.",
						);
					}
					const text = await response.text();
					controller.signal.throwIfAborted();
					if (text.length > 16000) throw new Error("Invalid task response");
					const result = taskSchema.parse(JSON.parse(text).task);
					if (result.id !== requestId || result.title !== submitted!.title) {
						throw new Error("Task response does not match this request");
					}
					saved = result;
					return result;
				} catch (error) {
					if (error instanceof Error && error.message.startsWith("This task")) {
						throw error;
					}
					throw new Error(
						"Could not confirm this task was saved. Check Tasks or try again. Your note is unchanged.",
					);
				} finally {
					clearTimeout(timer);
					pending = undefined;
				}
			})();
			return pending;
		},
	};
};

/** Opening or cancelling a dialog must not schedule a lazy note save. */
export const setTaskEditorEditable = (
	editor: Pick<Editor, "setEditable">,
	editable: boolean,
): void => {
	editor.setEditable(editable, false);
};

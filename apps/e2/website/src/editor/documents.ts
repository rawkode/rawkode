import { z } from "zod";
import { type NoteDocument, parseNote } from "@e2/documents/note";

const envelopeSchema = z.object({
	document: z.object({
		id: z.string(),
		note: z.unknown().transform((value) => parseNote(value)),
		revision: z.number().int().positive(),
		updatedAt: z.string(),
	}).nullable(),
});
export type SavedDocument = NonNullable<
	z.infer<typeof envelopeSchema>["document"]
>;
export type SaveState =
	| "idle"
	| "pending"
	| "saving"
	| "saved"
	| "error"
	| "conflict";
export const todayDate = (date = new Date()): string =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${
		String(date.getDate()).padStart(2, "0")
	}`;
export const todayBounds = (date = new Date()) => {
	const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
	return {
		date: todayDate(date),
		from: start.toISOString(),
		to: end.toISOString(),
	};
};
export const todayDocumentId = (date = new Date()): string =>
	`daily:${todayDate(date)}`;

const endpoint = (id: string) => `/api/documents/${encodeURIComponent(id)}`;
export const readDocument = async (
	id: string,
): Promise<SavedDocument | null> => {
	const response = await fetch(endpoint(id), { cache: "no-store" });
	if (!response.ok) {
		throw new Error("Could not load this note. Try again before editing.");
	}
	const { document } = envelopeSchema.parse(await response.json());
	if (document && document.id !== id) {
		throw new Error("The server returned a different note.");
	}
	return document;
};

/** One in-flight write; retain edits made during a save and stop on conflicts. */
export const createDocumentSaver = ({
	id,
	revision: initialRevision,
	onState,
	request = fetch,
	delay = 600,
}: {
	id: string;
	revision: number | null;
	onState: (state: SaveState, message?: string) => void;
	request?: typeof fetch;
	delay?: number;
}) => {
	let revision = initialRevision;
	let pending: NoteDocument | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;
	let stopped = false;
	let disposed = false;
	let state: SaveState = "idle";
	let activeWrite: Promise<void> | undefined;
	const report = (next: SaveState, message?: string) => {
		state = next;
		if (!disposed) onState(next, message);
	};
	const writePending = async (): Promise<void> => {
		if (stopped || disposed || !pending) return;
		const note = pending;
		pending = undefined;
		saving = true;
		report("saving");
		try {
			const response = await request(endpoint(id), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ note, expectedRevision: revision }),
			});
			if (response.status === 409) {
				pending ??= note;
				stopped = true;
				report(
					"conflict",
					"This note changed in another window. Export your changes, then reload to open the saved version.",
				);
				return;
			}
			if (!response.ok) {
				throw new Error(
					"Your changes could not be saved. Try again or export a copy before leaving.",
				);
			}
			const { document } = envelopeSchema.parse(await response.json());
			if (
				!document || document.id !== id ||
				document.revision !== (revision ?? 0) + 1
			) {
				throw new Error(
					"The server returned an invalid save response. Export a copy before leaving.",
				);
			}
			revision = document.revision;
			report(pending ? "pending" : "saved");
		} catch (failure) {
			pending ??= note;
			stopped = true;
			report(
				"error",
				failure instanceof Error
					? failure.message
					: "Could not save your changes.",
			);
		} finally {
			saving = false;
		}
	};
	const flush = async (): Promise<boolean> => {
		clearTimeout(timer);
		while (!stopped && !disposed && (activeWrite || pending)) {
			if (!activeWrite) activeWrite = writePending();
			const write = activeWrite;
			await write;
			if (activeWrite === write) activeWrite = undefined;
		}
		return !saving && !pending && !stopped;
	};
	return {
		schedule: (note: NoteDocument) => {
			pending = parseNote(note);
			if (stopped || disposed) return;
			report("pending");
			clearTimeout(timer);
			timer = setTimeout(() => void flush(), delay);
		},
		retry: () => {
			if (state === "conflict") return;
			stopped = false;
			void flush();
		},
		flush,
		hasUnsavedChanges: () => saving || !!pending,
		dispose: () => {
			disposed = true;
			clearTimeout(timer);
		},
	};
};

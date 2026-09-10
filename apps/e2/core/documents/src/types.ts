import type { NoteDocument } from "@e2/documents/note";

export interface StoredDocument {
	id: string;
	note: NoteDocument;
	revision: number;
	createdAt: string;
	updatedAt: string;
}
export interface DocumentSummary {
	id: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
}
export interface DocumentBacklink extends DocumentSummary {
	entityId: string;
}
export type SaveResult = { ok: true; document: StoredDocument } | {
	ok: false;
	conflict: StoredDocument | null;
};
export interface DocumentsApi {
	get(id: string): Promise<StoredDocument | null>;
	list(prefix: string, limit?: number): Promise<DocumentSummary[]>;
	backlinks(entityId: string, limit?: number): Promise<DocumentBacklink[]>;
	save(
		id: string,
		note: unknown,
		expectedRevision: number | null,
	): Promise<SaveResult>;
}

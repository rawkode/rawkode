import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import {
	type CanonicalEntityReference,
	type NoteDocument,
	parseNote,
} from "@e2/documents/note";
import { documentChunks, documentEntityRefs, documents } from "../schema.ts";
import type {
	DocumentBacklink,
	DocumentSummary,
	SaveResult,
	StoredDocument,
} from "./types.ts";

/** Drizzle is the only SQL adapter used by the Documents persistence layer. */
export type DocumentDatabase = ReturnType<typeof drizzle>;

interface DocumentRow {
	id: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

// Stay below SQLite's 2 MB row limit without cutting a Unicode surrogate pair.
const noteChunks = (json: string): string[] => {
	const chunks: string[] = [];
	for (let offset = 0; offset < json.length;) {
		let end = Math.min(offset + 256 * 1024, json.length);
		if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1]!)) end--;
		chunks.push(json.slice(offset, end));
		offset = end;
	}
	return chunks;
};

const validateId = (id: string): void => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(id)) {
		throw new Error("Invalid document ID");
	}
};

const validateEntityId = (id: string): void => {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			.test(id)
	) throw new Error("Invalid entity ID");
};

const referencedEntities = (note: NoteDocument): string[] => {
	const ids = new Set<string>();
	const stack: unknown[] = [note];
	while (stack.length) {
		const value = stack.pop();
		if (!value || typeof value !== "object") continue;
		if (
			!Array.isArray(value) &&
			(value as { type?: unknown }).type === "entity"
		) {
			const entity = (value as {
				attrs?: { entity?: Partial<CanonicalEntityReference> };
			}).attrs?.entity;
			if (entity?.version === 1 && typeof entity.entityId === "string") {
				ids.add(entity.entityId);
			}
		}
		if (Array.isArray(value)) stack.push(...value);
		else stack.push(...Object.values(value));
	}
	return [...ids].sort();
};

const prefixUpperBound = (prefix: string): string => {
	// Event prefixes always end in ':'. A range keeps '_' in provider IDs
	// literal instead of giving SQLite LIKE wildcard semantics.
	return `${prefix.slice(0, -1)};`;
};

const readDocument = (
	db: Pick<DocumentDatabase, "select">,
	id: string,
): StoredDocument | null => {
	const row = db.select().from(documents).where(eq(documents.id, id)).get() as
		| DocumentRow
		| undefined;
	if (!row) return null;
	const chunks = db.select({ content: documentChunks.content })
		.from(documentChunks)
		.where(eq(documentChunks.documentId, id))
		.orderBy(asc(documentChunks.position))
		.all();
	return {
		id: row.id,
		note: parseNote(chunks.map(({ content }) => content).join("")),
		revision: row.revision,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
};

export const createDocumentStore = (
	db: DocumentDatabase,
	now = (): string => new Date().toISOString(),
) => {
	const get = (id: string): StoredDocument | null => {
		validateId(id);
		return readDocument(db, id);
	};
	const list = (prefix: string, limit = 50): DocumentSummary[] => {
		if (
			typeof prefix !== "string" ||
			(prefix !== "capture:" &&
				!/^event(?:-series)?:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+){1,2}:$/.test(
					prefix,
				)) ||
			prefix.length > 180
		) {
			throw new Error("Invalid document prefix");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Invalid document limit");
		}
		return db.select({
			id: documents.id,
			revision: documents.revision,
			createdAt: documents.createdAt,
			updatedAt: documents.updatedAt,
		}).from(documents).where(
			and(
				gte(documents.id, prefix),
				lt(documents.id, prefixUpperBound(prefix)),
			),
		)
			.orderBy(asc(documents.id)).limit(limit).all() as DocumentSummary[];
	};
	const backlinks = (
		entityIds: string | readonly string[],
		limit = 50,
	): DocumentBacklink[] => {
		const ids = [
			...new Set(typeof entityIds === "string" ? [entityIds] : entityIds),
		];
		if (!ids.length || ids.length > 10_000) {
			throw new Error("Invalid entity IDs");
		}
		ids.forEach(validateEntityId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Invalid document limit");
		}
		const matches = ids.flatMap((_, offset) => {
			if (offset % 90 !== 0) return [];
			return db.select({
				id: documents.id,
				entityId: documentEntityRefs.entityId,
				revision: documents.revision,
				createdAt: documents.createdAt,
				updatedAt: documents.updatedAt,
			}).from(documentEntityRefs).innerJoin(
				documents,
				eq(documentEntityRefs.documentId, documents.id),
			).where(
				inArray(documentEntityRefs.entityId, ids.slice(offset, offset + 90)),
			)
				.orderBy(desc(documents.updatedAt), asc(documents.id)).limit(limit)
				.all() as DocumentBacklink[];
		});
		return [...new Map(
			matches.sort((left, right) =>
				right.updatedAt.localeCompare(left.updatedAt) ||
				left.id.localeCompare(right.id)
			).map((match) => [match.id, match]),
		).values()].slice(0, limit);
	};
	const save = (
		id: string,
		value: unknown,
		expectedRevision: number | null,
	): SaveResult => {
		validateId(id);
		if (
			expectedRevision !== null &&
			(!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
				expectedRevision >= Number.MAX_SAFE_INTEGER)
		) throw new Error("Invalid document revision");
		const note = parseNote(value);
		const chunks = noteChunks(JSON.stringify(note));
		return db.transaction((tx) => {
			const current = readDocument(tx, id);
			if ((current?.revision ?? null) !== expectedRevision) {
				return { ok: false, conflict: current };
			}
			const timestamp = now();
			const document = {
				id,
				note,
				revision: (current?.revision ?? 0) + 1,
				createdAt: current?.createdAt ?? timestamp,
				updatedAt: timestamp,
			};
			tx.insert(documents).values({
				id,
				revision: document.revision,
				createdAt: document.createdAt,
				updatedAt: document.updatedAt,
			}).onConflictDoUpdate({
				target: documents.id,
				set: {
					revision: document.revision,
					updatedAt: document.updatedAt,
				},
			}).run();
			tx.delete(documentChunks).where(eq(documentChunks.documentId, id)).run();
			// Keep each statement below SQLite's 100-bound-parameter limit. A
			// single multi-row insert would make otherwise-valid large notes fail.
			chunks.forEach((content, position) => {
				tx.insert(documentChunks).values({
					documentId: id,
					position,
					content,
				}).run();
			});
			tx.delete(documentEntityRefs).where(
				eq(documentEntityRefs.documentId, id),
			).run();
			for (const entityId of referencedEntities(note)) {
				tx.insert(documentEntityRefs).values({ documentId: id, entityId })
					.run();
			}
			return { ok: true, document };
		});
	};
	return { get, list, backlinks, save };
};

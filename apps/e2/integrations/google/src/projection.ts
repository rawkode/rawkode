import {
	type EntitiesApi,
	INTEGRATION_TAGS,
	type ProjectionRecord,
} from "@e2/entities";
import type { AccountDatabase, AccountStatement } from "./storage.ts";

export const CONTACT_PROJECTION_BATCH_SIZE = 50;

export interface EntitiesAdminBinding {
	admin(ownerId: string): Promise<EntitiesApi & Disposable>;
}

export interface ContactProjection {
	projectionId: string;
	resourceId: string;
	sourceRevision: string;
	label?: string;
	aliases: readonly string[];
	values?: Readonly<Record<string, unknown>>;
	deleted: boolean;
}

interface OutboxRow {
	sequence: number;
	projection_id: string;
	connection_id: string;
	owner_id: string;
	resource_type: string;
	resource_id: string;
	source_revision: string;
	label: string | null;
	aliases: string;
	values: string | null;
	deleted: number;
}

const objects = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.filter((entry): entry is Record<string, unknown> =>
			entry !== null && typeof entry === "object" && !Array.isArray(entry)
		)
		: [];

const text = (value: unknown, limit = 1_000): string =>
	typeof value === "string" ? value.trim().slice(0, limit) : "";

const unique = (
	values: readonly string[],
): string[] => [...new Set(values.filter(Boolean))];

const email = (value: unknown): string => {
	const candidate = text(value, 320).toLocaleLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
};

const httpUrl = (value: unknown): string => {
	const candidate = text(value, 8_192);
	try {
		const url = new URL(candidate);
		return ["http:", "https:"].includes(url.protocol) && !url.username &&
				!url.password
			? candidate
			: "";
	} catch {
		return "";
	}
};

const digest = async (value: string): Promise<string> => {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(bytes)].map((byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
};

const stableProjectionId = (
	connectionId: string,
	resourceId: string,
	sourceRevision: string,
): string =>
	JSON.stringify([
		"google",
		connectionId,
		"contact",
		resourceId,
		sourceRevision,
	]);

/** Normalize only fields supported by the locked Person base. */
export const googleContactProjection = async (
	connectionId: string,
	resourceId: string,
	data: Record<string, unknown>,
	deleted: boolean,
): Promise<ContactProjection> => {
	const names = objects(data.names).map((entry) =>
		text(entry.displayName) || text(entry.unstructuredName)
	).filter(Boolean);
	const emails = unique(
		objects(data.emailAddresses).map((entry) => email(entry.value)),
	);
	const phones = unique(
		objects(data.phoneNumbers).map((entry) => text(entry.value, 1_000)),
	);
	const avatar = objects(data.photos).map((entry) => httpUrl(entry.url)).find(
		Boolean,
	) ?? "";
	const label = names[0] || emails[0] || phones[0] || "Unnamed contact";
	const aliases = unique([...names.slice(1), ...emails]);
	const values: Record<string, unknown> = {
		"field:person:name": label,
		"field:person:emails": emails,
		"field:person:phones": phones,
	};
	if (avatar) values["field:person:avatar"] = avatar;
	const normalized = deleted
		? { resourceId, deleted: true }
		: { resourceId, label, aliases, values, deleted: false };
	const sourceRevision = `${deleted ? "deleted" : "active"}:${await digest(
		JSON.stringify(normalized),
	)}`;
	return {
		projectionId: stableProjectionId(
			connectionId,
			resourceId,
			sourceRevision,
		),
		resourceId,
		sourceRevision,
		label: deleted ? undefined : label,
		aliases: deleted ? [] : aliases,
		values: deleted ? undefined : values,
		deleted,
	};
};

export const enqueueContactProjection = (
	db: AccountDatabase,
	ownerId: string,
	connectionId: string,
	projection: ContactProjection,
	createdAt: number,
	lease: string,
): AccountStatement =>
	db.prepare(
		`INSERT OR IGNORE INTO entity_projection_outbox
      (projection_id, connection_id, owner_id, resource_type, resource_id,
       source_revision, label, aliases, "values", deleted, created_at)
     SELECT ?, ?, ?, 'contact', ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM google_syncs
         WHERE connection_id = ? AND collection = 'contacts'
           AND lease = ? AND lease_until > ?
      )`,
	).bind(
		projection.projectionId,
		connectionId,
		ownerId,
		projection.resourceId,
		projection.sourceRevision,
		projection.label ?? null,
		JSON.stringify(projection.aliases),
		projection.values === undefined ? null : JSON.stringify(projection.values),
		projection.deleted ? 1 : 0,
		createdAt,
		connectionId,
		lease,
		createdAt,
	);

/**
 * A completed baseline can discover contacts absent from the provider page set.
 * Their revision and projection ID derive from the last active observation, so
 * retrying the same sweep produces the same tombstone.
 */
export const enqueueMissingContactTombstones = (
	db: AccountDatabase,
	ownerId: string,
	connectionId: string,
	generation: string,
	lease: string,
	now: number,
): AccountStatement =>
	db.prepare(
		`INSERT OR IGNORE INTO entity_projection_outbox
      (projection_id, connection_id, owner_id, resource_type, resource_id,
	       source_revision, label, aliases, "values", deleted, created_at)
	     SELECT json_array('google', r.connection_id, 'contact', r.resource_id,
	              'deleted:' || COALESCE(r.source_revision, 'legacy')),
	            r.connection_id, ?, 'contact', r.resource_id,
	            'deleted:' || COALESCE(r.source_revision, 'legacy'),
            NULL, '[]', NULL, 1, ?
       FROM google_records r
      WHERE r.connection_id = ? AND r.collection = 'contacts' AND r.deleted = 0
        AND NOT EXISTS (
          SELECT 1 FROM google_staging s
           WHERE s.generation = ? AND s.resource_id = r.resource_id
        )
        AND EXISTS (
          SELECT 1 FROM google_syncs g
           WHERE g.connection_id = ? AND g.collection = 'contacts'
             AND g.lease = ? AND g.lease_until > ?
        )`,
	).bind(
		ownerId,
		now,
		connectionId,
		generation,
		connectionId,
		lease,
		now,
	);

const record = (row: OutboxRow): ProjectionRecord => ({
	resourceType: row.resource_type,
	resourceId: row.resource_id,
	sourceRevision: row.source_revision,
	tagId: INTEGRATION_TAGS.googleContact,
	...(row.label === null ? {} : { label: row.label }),
	aliases: JSON.parse(row.aliases) as string[],
	...(row.values === null
		? {}
		: { values: JSON.parse(row.values) as Record<string, unknown> }),
	deleted: row.deleted === 1,
});

export const drainContactProjectionOutbox = async (
	db: AccountDatabase,
	binding: EntitiesAdminBinding | undefined,
	connectionId: string,
	limit = CONTACT_PROJECTION_BATCH_SIZE,
): Promise<{ delivered: number; pending: boolean }> => {
	if (!binding) return { delivered: 0, pending: false };
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Invalid projection batch size");
	}
	const { results } = await db.prepare(
		`SELECT sequence, projection_id, connection_id, owner_id, resource_type,
	            resource_id, source_revision, label, aliases, "values", deleted
       FROM entity_projection_outbox
      WHERE connection_id = ? ORDER BY sequence LIMIT ?`,
	).bind(connectionId, limit).all<OutboxRow>();
	if (!results.length) return { delivered: 0, pending: false };
	const ownerId = results[0]!.owner_id;
	if (
		results.some((row) =>
			row.owner_id !== ownerId || row.connection_id !== connectionId
		)
	) throw new Error("Projection outbox identity mismatch");
	try {
		using entities = await binding.admin(ownerId);
		await entities.upsertProjectionBatch({
			provider: "google",
			connectionId,
			records: results.map(record),
			provenance: {
				actor: "integration:google",
				cause: `contact-outbox:${results[0]!.sequence}-${
					results.at(-1)!.sequence
				}`,
				rationale: "Project a synchronized Google contact observation.",
			},
		});
		await db.batch(
			results.map((row) =>
				db.prepare(
					"DELETE FROM entity_projection_outbox WHERE sequence = ? AND projection_id = ?",
				).bind(row.sequence, row.projection_id)
			),
		);
	} catch {
		await db.batch(
			results.map((row) =>
				db.prepare(
					"UPDATE entity_projection_outbox SET attempts = attempts + 1, last_error = 'Entity projection failed' WHERE sequence = ? AND projection_id = ?",
				).bind(row.sequence, row.projection_id)
			),
		);
		throw new Error("Google contact projection will retry");
	}
	const pending = await db.prepare(
		"SELECT 1 AS pending FROM entity_projection_outbox WHERE connection_id = ? LIMIT 1",
	).bind(connectionId).first<{ pending: number }>();
	return { delivered: results.length, pending: pending !== null };
};

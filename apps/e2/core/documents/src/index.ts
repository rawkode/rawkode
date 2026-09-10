import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../migrations/migrations.js";
import { createDocumentStore } from "./storage.ts";
import type { DocumentsApi } from "./types.ts";
export type {
	DocumentBacklink,
	DocumentsApi,
	DocumentSummary,
	SaveResult,
	StoredDocument,
} from "./types.ts";

interface DocumentsEnv {
	DOCUMENTS: DurableObjectNamespace<Documents>;
}

export class Documents extends DurableObject<DocumentsEnv> {
	#documents: ReturnType<typeof createDocumentStore>;
	constructor(ctx: DurableObjectState, env: DocumentsEnv) {
		super(ctx, env);
		const db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(() =>
			Promise.resolve().then(() => migrate(db, migrations))
		);
		this.#documents = createDocumentStore(db);
	}
	get(id: string) {
		return this.#documents.get(id);
	}
	list(prefix: string, limit?: number) {
		return this.#documents.list(prefix, limit);
	}
	backlinks(entityId: string, limit?: number) {
		return this.#documents.backlinks(entityId, limit);
	}
	save(id: string, note: unknown, expectedRevision: number | null) {
		return this.#documents.save(id, note, expectedRevision);
	}
}

class OwnerDocuments extends RpcTarget implements DocumentsApi {
	#documents: DocumentsApi;
	constructor(documents: DurableObjectStub<Documents>) {
		super();
		// Recursive note types exceed Cloudflare RPC mapped-type expansion.
		this.#documents = documents as unknown as DocumentsApi;
	}
	get(id: string) {
		return this.#documents.get(id);
	}
	list(prefix: string, limit?: number) {
		return this.#documents.list(prefix, limit);
	}
	backlinks(entityId: string, limit?: number) {
		return this.#documents.backlinks(entityId, limit);
	}
	save(id: string, note: unknown, expectedRevision: number | null) {
		return this.#documents.save(id, note, expectedRevision);
	}
}

/** Only trusted service bindings may assert an owner; no public RPC route exists. */
export class DocumentsAdmin extends WorkerEntrypoint<DocumentsEnv> {
	admin(ownerId: string) {
		if (
			typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 200
		) throw new Error("Unauthorized");
		return new OwnerDocuments(
			this.env.DOCUMENTS.get(this.env.DOCUMENTS.idFromName(ownerId)),
		);
	}
}

export default {
	fetch: (request: Request) =>
		new URL(request.url).pathname === "/health"
			? Response.json({ service: "core-documents", status: "ok" })
			: new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<DocumentsEnv>;

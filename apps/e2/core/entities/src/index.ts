import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type {
	CreateEntityInput,
	CreateUserTagInput,
	DefineFieldInput,
	EntitiesApi,
	EntitySearchOptions,
	EntitySource,
	MutationProvenance,
	ProjectionBatch,
} from "@e2/entities";
import migrations from "../migrations/migrations.js";
import { createEntityStore } from "./storage.ts";
export type * from "@e2/entities";
export { createEntityStore, type EntityDatabase } from "./storage.ts";

interface EntitiesEnv {
	ENTITIES: DurableObjectNamespace<Entities>;
}

export class Entities extends DurableObject<EntitiesEnv> {
	#store: ReturnType<typeof createEntityStore>;
	constructor(ctx: DurableObjectState, env: EntitiesEnv) {
		super(ctx, env);
		const db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(() =>
			Promise.resolve().then(() => migrate(db, migrations))
		);
		this.#store = createEntityStore(db);
	}
	listTags() {
		return this.#store.listTags();
	}
	searchEntities(query: string, options?: EntitySearchOptions) {
		return this.#store.searchEntities(query, options);
	}
	createUserTag(input: CreateUserTagInput, provenance: MutationProvenance) {
		return this.#store.createUserTag(input, provenance);
	}
	defineField(input: DefineFieldInput, provenance: MutationProvenance) {
		return this.#store.defineField(input, provenance);
	}
	createEntity(input: CreateEntityInput, provenance: MutationProvenance) {
		return this.#store.createEntity(input, provenance);
	}
	getEntity(id: string) {
		return this.#store.getEntity(id);
	}
	setUserValues(
		id: string,
		values: Readonly<Record<string, unknown>>,
		clear: readonly string[],
		provenance: MutationProvenance,
	) {
		return this.#store.setUserValues(id, values, clear, provenance);
	}
	setPreferredSource(
		id: string,
		fieldId: string,
		source: EntitySource | null,
		provenance: MutationProvenance,
	) {
		return this.#store.setPreferredSource(id, fieldId, source, provenance);
	}
	mergeEntities(
		fromId: string,
		intoId: string,
		provenance: MutationProvenance,
	) {
		return this.#store.mergeEntities(fromId, intoId, provenance);
	}
	upsertProjectionBatch(batch: ProjectionBatch) {
		return this.#store.upsertProjectionBatch(batch);
	}
}

class OwnerEntities extends RpcTarget implements EntitiesApi {
	#entities: EntitiesApi;
	constructor(stub: DurableObjectStub<Entities>) {
		super();
		this.#entities = stub as unknown as EntitiesApi;
	}
	listTags() {
		return this.#entities.listTags();
	}
	searchEntities(query: string, options?: EntitySearchOptions) {
		return this.#entities.searchEntities(query, options);
	}
	createUserTag(input: CreateUserTagInput, provenance: MutationProvenance) {
		return this.#entities.createUserTag(input, provenance);
	}
	defineField(input: DefineFieldInput, provenance: MutationProvenance) {
		return this.#entities.defineField(input, provenance);
	}
	createEntity(input: CreateEntityInput, provenance: MutationProvenance) {
		return this.#entities.createEntity(input, provenance);
	}
	getEntity(id: string) {
		return this.#entities.getEntity(id);
	}
	setUserValues(
		id: string,
		values: Readonly<Record<string, unknown>>,
		clear: readonly string[],
		provenance: MutationProvenance,
	) {
		return this.#entities.setUserValues(id, values, clear, provenance);
	}
	setPreferredSource(
		id: string,
		fieldId: string,
		source: EntitySource | null,
		provenance: MutationProvenance,
	) {
		return this.#entities.setPreferredSource(id, fieldId, source, provenance);
	}
	mergeEntities(
		fromId: string,
		intoId: string,
		provenance: MutationProvenance,
	) {
		return this.#entities.mergeEntities(fromId, intoId, provenance);
	}
	upsertProjectionBatch(batch: ProjectionBatch) {
		return this.#entities.upsertProjectionBatch(batch);
	}
}

/** Only trusted service bindings may assert an owner. */
export class EntitiesAdmin extends WorkerEntrypoint<EntitiesEnv> {
	admin(ownerId: string) {
		if (
			typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 200
		) throw new Error("Unauthorized");
		return new OwnerEntities(
			this.env.ENTITIES.get(this.env.ENTITIES.idFromName(ownerId)),
		);
	}
}

export default {
	fetch: (request: Request) =>
		new URL(request.url).pathname === "/health"
			? Response.json({ service: "core-entities", status: "ok" })
			: new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<EntitiesEnv>;

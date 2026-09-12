import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type {
	CreateEntityInput,
	CreateUserTagInput,
	DefineFieldInput,
	EntitiesApi,
	EntityMutationResult,
	EntitySearchOptions,
	EntitySource,
	MutationProvenance,
	ProjectionBatch,
} from "@e2/entities";
import migrations from "../migrations/migrations.js";
import { type createEntityStore, initializeEntityStore } from "./storage.ts";
export type * from "@e2/entities";
export {
	createEntityStore,
	type EntityDatabase,
	initializeEntityStore,
} from "./storage.ts";

interface EntitiesEnv {
	ENTITIES: DurableObjectNamespace<Entities>;
}

export class Entities extends DurableObject<EntitiesEnv> {
	#store!: ReturnType<typeof createEntityStore>;
	constructor(ctx: DurableObjectState, env: EntitiesEnv) {
		super(ctx, env);
		const db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(async () => {
			this.#store = await initializeEntityStore(
				db,
				() => migrate(db, migrations),
			);
		});
	}
	listTags() {
		return this.#store.listTags();
	}
	getTag(id: string) {
		return this.#store.getTag(id);
	}
	getTagArchiveImpact(id: string) {
		return this.#store.getTagArchiveImpact(id);
	}
	getFieldArchiveImpact(id: string) {
		return this.#store.getFieldArchiveImpact(id);
	}
	searchEntities(query: string, options?: EntitySearchOptions) {
		return this.#store.searchEntities(query, options);
	}
	createUserTag(input: CreateUserTagInput, provenance: MutationProvenance) {
		return this.#store.createUserTag(input, provenance);
	}
	renameUserTag(
		id: string,
		name: string,
		expectedRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#store.renameUserTag(id, name, expectedRevision, provenance);
	}
	archiveUserTag(
		id: string,
		expectedRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#store.archiveUserTag(id, expectedRevision, provenance);
	}
	defineField(input: DefineFieldInput, provenance: MutationProvenance) {
		return this.#store.defineField(input, provenance);
	}
	archiveField(
		id: string,
		expectedTagRevision: number,
		expectedValueCount: number,
		provenance: MutationProvenance,
	) {
		return this.#store.archiveField(
			id,
			expectedTagRevision,
			expectedValueCount,
			provenance,
		);
	}
	createEntity(input: CreateEntityInput, provenance: MutationProvenance) {
		return this.#store.createEntity(input, provenance);
	}
	getEntity(id: string) {
		return this.#store.getEntity(id);
	}
	getEntitySources(id: string) {
		return this.#store.getEntitySources(id);
	}
	setUserValues(
		id: string,
		values: Readonly<Record<string, unknown>>,
		clear: readonly string[],
		expectedRevision: number,
		provenance: MutationProvenance,
	): EntityMutationResult {
		return this.#store.setUserValues(
			id,
			values,
			clear,
			expectedRevision,
			provenance,
		);
	}
	setPreferredSource(
		id: string,
		fieldId: string,
		source: EntitySource | null,
		expectedRevision: number,
		provenance: MutationProvenance,
	): EntityMutationResult {
		return this.#store.setPreferredSource(
			id,
			fieldId,
			source,
			expectedRevision,
			provenance,
		);
	}
	mergeEntities(
		fromId: string,
		intoId: string,
		expectedFromRevision: number,
		expectedIntoRevision: number,
		provenance: MutationProvenance,
	): EntityMutationResult {
		return this.#store.mergeEntities(
			fromId,
			intoId,
			expectedFromRevision,
			expectedIntoRevision,
			provenance,
		);
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
	getTag(id: string) {
		return this.#entities.getTag(id);
	}
	getTagArchiveImpact(id: string) {
		return this.#entities.getTagArchiveImpact(id);
	}
	getFieldArchiveImpact(id: string) {
		return this.#entities.getFieldArchiveImpact(id);
	}
	searchEntities(query: string, options?: EntitySearchOptions) {
		return this.#entities.searchEntities(query, options);
	}
	createUserTag(input: CreateUserTagInput, provenance: MutationProvenance) {
		return this.#entities.createUserTag(input, provenance);
	}
	renameUserTag(
		id: string,
		name: string,
		expectedRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#entities.renameUserTag(id, name, expectedRevision, provenance);
	}
	archiveUserTag(
		id: string,
		expectedRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#entities.archiveUserTag(id, expectedRevision, provenance);
	}
	defineField(input: DefineFieldInput, provenance: MutationProvenance) {
		return this.#entities.defineField(input, provenance);
	}
	archiveField(
		id: string,
		expectedTagRevision: number,
		expectedValueCount: number,
		provenance: MutationProvenance,
	) {
		return this.#entities.archiveField(
			id,
			expectedTagRevision,
			expectedValueCount,
			provenance,
		);
	}
	createEntity(input: CreateEntityInput, provenance: MutationProvenance) {
		return this.#entities.createEntity(input, provenance);
	}
	getEntity(id: string) {
		return this.#entities.getEntity(id);
	}
	getEntitySources(id: string) {
		return this.#entities.getEntitySources(id);
	}
	setUserValues(
		id: string,
		values: Readonly<Record<string, unknown>>,
		clear: readonly string[],
		expectedRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#entities.setUserValues(
			id,
			values,
			clear,
			expectedRevision,
			provenance,
		);
	}
	setPreferredSource(
		id: string,
		fieldId: string,
		source: EntitySource | null,
		expectedRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#entities.setPreferredSource(
			id,
			fieldId,
			source,
			expectedRevision,
			provenance,
		);
	}
	mergeEntities(
		fromId: string,
		intoId: string,
		expectedFromRevision: number,
		expectedIntoRevision: number,
		provenance: MutationProvenance,
	) {
		return this.#entities.mergeEntities(
			fromId,
			intoId,
			expectedFromRevision,
			expectedIntoRevision,
			provenance,
		);
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

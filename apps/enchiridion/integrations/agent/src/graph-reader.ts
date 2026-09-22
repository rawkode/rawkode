import { z } from "zod";
import {
	type AuthConfig,
	authenticate,
} from "../../../website/src/lib/auth.ts";
import type { DayApiBinding } from "./day-reader.ts";
import { withinVoiceDeadline } from "./deadline.ts";

const id = z.string().min(1).max(200);
const label = z.string().max(2000);
const summary = z.object({
	id,
	label,
	rootId: id,
	bodyDocumentId: id,
	tagIds: z.array(id).max(64),
});
const tag = z.object({
	id,
	name: label,
	rootId: id,
	parentId: id.nullable(),
	archived: z.boolean(),
});
const field = z.object({
	id,
	key: label,
	label,
	type: z.string().max(80),
	cardinality: z.string().max(80),
	originTagId: id,
	inherited: z.boolean(),
});
const value = z.object({
	fieldId: id,
	text: z.string().max(8000).nullable(),
	number: z.number().finite().nullable(),
	boolean: z.boolean().nullable(),
	strings: z.array(label).max(64).nullable(),
	numbers: z.array(z.number().finite()).max(64).nullable(),
	booleans: z.array(z.boolean()).max(64).nullable(),
});
export const graphReadInputs = {
	search: z.object({
		query: z.string().trim().min(1).max(200),
		rootId: id.optional(),
	}).strict(),
	entity: z.object({ id }).strict(),
	tags: z.object({ query: z.string().max(200) }).strict(),
	tag: z.object({ id }).strict(),
	note: z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/) })
		.strict(),
};
export type GraphReadKind = keyof typeof graphReadInputs;
export const graphReadQueries = {
	search:
		`query VoiceGraphSearch($query: String!, $rootId: ID) { me { id entities(query: $query, rootId: $rootId, limit: 21) { id label rootId bodyDocumentId tagIds } } }`,
	entity:
		`query VoiceGraphEntity($id: ID!) { me { id entity(id: $id) { id label bodyDocumentId tagIds revision archived values { fieldId text number boolean strings numbers booleans } } } }`,
	tags:
		`query VoiceGraphTags { me { id supertags { id name rootId parentId archived } } }`,
	tag:
		`query VoiceGraphTag($id: ID!) { me { id supertag(id: $id) { tag { id name rootId parentId archived } fields { id key label type cardinality originTagId inherited } } } }`,
	note:
		`query VoiceGraphNote($id: ID!) { me { id document(id: $id) { id revision updatedAt note } } }`,
};
const object = z.record(z.string(), z.unknown());

// Only editor text and entity labels leave the host; attributes, embeds, URLs,
// credentials and arbitrary JSON properties are never passed through to code mode.
const noteText = (note: unknown) => {
	const chunks: string[] = [];
	let nodes = 0, length = 0, partial = false;
	const visit = (node: unknown, depth: number) => {
		if (++nodes > 2000 || depth > 32 || length >= 8000) {
			partial = true;
			return;
		}
		const parsed = object.safeParse(node);
		if (!parsed.success) return;
		const record = parsed.data;
		if (record.type === "text" && typeof record.text === "string") {
			const text = record.text.slice(0, 8000 - length);
			partial ||= text.length !== record.text.length;
			chunks.push(text);
			length += text.length;
		}
		if (Array.isArray(record.content)) {
			for (const child of record.content) {
				if (nodes >= 2000 || length >= 8000) {
					partial = true;
					break;
				}
				visit(child, depth + 1);
			}
			if (length < 8000) {
				chunks.push("\n");
				length++;
			}
		}
	};
	visit(note, 0);
	return { text: chunks.join("").trim(), partial };
};
const project = (
	kind: GraphReadKind,
	me: Record<string, unknown>,
	input: Record<string, unknown>,
) => {
	switch (kind) {
		case "search": {
			const items = z.array(summary).max(21).parse(me.entities);
			return { items: items.slice(0, 20), partial: items.length > 20 };
		}
		case "tags": {
			const items = z.array(tag).max(1000).parse(me.supertags).filter((item) =>
				!item.archived &&
				item.name.toLocaleLowerCase().includes(
					String(input.query).toLocaleLowerCase(),
				)
			);
			return { items: items.slice(0, 20), partial: items.length > 20 };
		}
		case "entity": {
			const entity = z.object({
				id,
				label,
				bodyDocumentId: id,
				tagIds: z.array(id).max(64),
				revision: z.number().int(),
				archived: z.boolean(),
				values: z.array(value).max(128),
			}).nullable().parse(me.entity);
			if (entity && entity.id !== input.id) {
				throw new Error("Graph entity identity mismatch");
			}
			return { entity, partial: false };
		}
		case "tag": {
			const details = z.object({ tag, fields: z.array(field).max(128) })
				.nullable().parse(me.supertag);
			if (details && details.tag.id !== input.id) {
				throw new Error("Graph tag identity mismatch");
			}
			return { details, partial: false };
		}
		case "note": {
			const document = z.object({
				id,
				revision: z.number().int(),
				updatedAt: z.string().max(64),
				note: z.unknown(),
			}).nullable().parse(me.document);
			if (!document) return { document: null, partial: false };
			if (document.id !== input.id) {
				throw new Error("Graph document identity mismatch");
			}
			const { text, partial } = noteText(document.note);
			return {
				document: {
					id: document.id,
					revision: document.revision,
					updatedAt: document.updatedAt,
					text,
				},
				partial,
			};
		}
	}
};

export type GraphReader = (
	owner: string,
	kind: GraphReadKind,
	input: unknown,
	signal: AbortSignal,
) => Promise<unknown>;
export const createApiGraphReader = async (
	request: Request,
	config: AuthConfig,
	api: DayApiBinding,
	options: {
		authenticate?: typeof authenticate;
		timeoutMs?: number;
		clock?: () => Date;
	} = {},
): Promise<GraphReader> => {
	const identity = await (options.authenticate ?? authenticate)(
		request,
		config,
	);
	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!identity || !assertion || assertion.length > 16384) {
		throw new Error("Unauthorized graph reader");
	}
	const endpoint = new URL("/api/graphql", config.WEBSITE_ORIGIN);
	if (endpoint.protocol !== "https:") throw new Error("Invalid graph origin");
	return async (owner, kind, input, signal) => {
		if (owner !== identity.ownerId) {
			throw new Error("Graph reader owner mismatch");
		}
		const schema = Object.hasOwn(graphReadInputs, kind)
			? graphReadInputs[kind]
			: undefined;
		if (!schema) throw new Error("Unknown graph read");
		const variables = schema.parse(input);
		signal.throwIfAborted();
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			return await withinVoiceDeadline(async () => {
				controller.signal.throwIfAborted();
				const response = await api.fetch(
					new Request(endpoint, {
						method: "POST",
						redirect: "manual",
						signal: controller.signal,
						headers: {
							"Content-Type": "application/json",
							Origin: endpoint.origin,
							"Cf-Access-Jwt-Assertion": assertion,
						},
						body: JSON.stringify({ query: graphReadQueries[kind], variables }),
					}),
				);
				const reader = response.body?.getReader();
				if (!response.ok || !reader) {
					await response.body?.cancel();
					throw new Error("Graph API unavailable");
				}
				const cancelBody = () => {
					void reader.cancel().catch(() => {});
				};
				controller.signal.addEventListener("abort", cancelBody, { once: true });
				let size = 0;
				const chunks: Uint8Array[] = [];
				try {
					for (;;) {
						controller.signal.throwIfAborted();
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > 262144) throw new Error("Graph response exceeds budget");
						chunks.push(value);
					}
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
					controller.signal.removeEventListener("abort", cancelBody);
				}
				controller.signal.throwIfAborted();
				const bytes = new Uint8Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				const envelope = object.parse(
					JSON.parse(new TextDecoder().decode(bytes)),
				);
				if (
					envelope.errors !== undefined &&
					(!Array.isArray(envelope.errors) || envelope.errors.length)
				) throw new Error("Graph data incomplete");
				const me = object.parse(object.parse(envelope.data).me);
				if (me.id !== identity.ownerId) {
					throw new Error("Graph API owner mismatch");
				}
				const result = {
					...project(kind, me, variables),
					source: "knowledge-graph",
					observedAt: (options.clock ?? (() => new Date()))().toISOString(),
					sourceFreshness: "unknown",
				};
				if (new TextEncoder().encode(JSON.stringify(result)).length > 20000) {
					throw new Error("Graph result exceeds budget");
				}
				return result;
			}, options.timeoutMs ?? 4000);
		} finally {
			controller.abort();
			signal.removeEventListener("abort", abort);
		}
	};
};

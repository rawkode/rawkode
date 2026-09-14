import type { APIRoute } from "astro";
import { NOTE_LIMITS, parseNote } from "@e2/documents/note";
import { bindings } from "../../../lib/env.ts";

const validId = (id: string | undefined): id is string =>
	typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(id);
const decodeId = (value: string | undefined): string | undefined => {
	if (typeof value !== "string") return undefined;
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
};

const readJSON = async (request: Request): Promise<unknown> => {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > NOTE_LIMITS.bytes + 1024) {
				await reader.cancel();
				throw new Error("Document too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
};

export const GET: APIRoute = async ({ params, locals }) => {
	const id = decodeId(params.id);
	if (!validId(id)) {
		return Response.json({ error: "Invalid document ID" }, { status: 400 });
	}
	using documents = await bindings.DOCUMENTS_ADMIN.admin(locals.admin.ownerId);
	return Response.json({ document: await documents.get(id) });
};

export const POST: APIRoute = async ({ params, locals, request }) => {
	const id = decodeId(params.id);
	if (!validId(id)) {
		return Response.json({ error: "Invalid document ID" }, { status: 400 });
	}
	if (
		request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
			"application/json"
	) {
		return Response.json({ error: "Expected JSON" }, { status: 415 });
	}
	let input;
	try {
		const value = await readJSON(request);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Invalid request");
		}
		const body = value as Record<string, unknown>;
		if (
			Object.keys(body).some((key) =>
				!["note", "expectedRevision"].includes(key)
			)
		) throw new Error("Unknown field");
		if (
			body.expectedRevision !== null &&
			!(Number.isSafeInteger(body.expectedRevision) &&
				Number(body.expectedRevision) > 0 &&
				Number(body.expectedRevision) < Number.MAX_SAFE_INTEGER)
		) throw new Error("Missing revision");
		input = {
			note: parseNote(body.note),
			expectedRevision: body.expectedRevision as number | null,
		};
	} catch {
		return Response.json({ error: "Invalid document or revision" }, {
			status: 400,
		});
	}
	using documents = await bindings.DOCUMENTS_ADMIN.admin(locals.admin.ownerId);
	const result = await documents.save(
		id,
		input.note,
		input.expectedRevision,
	);
	return result.ok
		? Response.json({ document: result.document })
		: Response.json({
			error: "Document changed in another tab. Reload before editing further.",
			document: result.conflict,
		}, { status: 409 });
};

export async function readJSON(
	request: Request,
	origin: string,
	limit = 8192,
): Promise<unknown> {
	if (request.headers.get("origin") !== origin)
		throw new Error("Only same-origin requests are accepted.");
	if (!request.headers.get("content-type")?.startsWith("application/json"))
		throw new Error("Expected JSON.");
	if (Number(request.headers.get("content-length")) > limit)
		throw new Error("Request is too large.");
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing request body.");
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new Error("Request is too large.");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

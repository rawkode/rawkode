export const readForm = async (request: Request): Promise<URLSearchParams> => {
	if (
		!request.headers.get("Content-Type")?.startsWith(
			"application/x-www-form-urlencoded",
		)
	) {
		throw new Error("Invalid form encoding");
	}
	if (Number(request.headers.get("Content-Length")) > 4096) {
		throw new Error("Form too large");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing form");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4096) {
				await reader.cancel();
				throw new Error("Form too large");
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
	return new URLSearchParams(new TextDecoder().decode(bytes));
};

export const requiredField = (form: URLSearchParams, key: string) => {
	const values = form.getAll(key);
	if (values.length !== 1 || !values[0] || values[0].length > 200) {
		throw new Error("Invalid field");
	}
	return values[0];
};

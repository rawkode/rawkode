/** Forward only the authenticated voice protocol through a private binding. */
export const forwardVoiceRequest = (
	request: Request,
	voice: Pick<Fetcher, "fetch">,
): Promise<Response> => {
	const path = new URL(request.url).pathname;
	if (
		path !== "/api/voice/status" &&
		path !== "/api/voice/recovery" &&
		path !== "/api/voice/sessions" &&
		!/^\/api\/voice\/sessions\/[A-Za-z0-9_-]{1,200}\/(end|day)$/.test(path)
	) return Promise.resolve(new Response("Not found", { status: 404 }));
	if (request.method !== "POST") {
		return Promise.resolve(
			new Response("Method not allowed", {
				status: 405,
				headers: { Allow: "POST" },
			}),
		);
	}
	const headers = new Headers();
	for (const name of ["Content-Type", "Origin", "Cf-Access-Jwt-Assertion"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	return voice.fetch(
		new Request(request.url, {
			method: "POST",
			headers,
			body: request.body,
			signal: request.signal,
		}),
	);
};

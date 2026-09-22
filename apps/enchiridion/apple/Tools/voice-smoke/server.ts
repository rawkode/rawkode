/** Local, opt-in real-provider smoke test. Never deployed with the application. */
const inputPath = Deno.args[0];
const outputDirectory = Deno.args[1];
if (!inputPath || !outputDirectory) {
	throw new Error("Usage: server.ts input.wav output-directory; see README.md");
}
const input = await Deno.readFile(inputPath);
if (input.length > 8_000_000) throw new Error("Input audio exceeds 8 MB");
await Deno.mkdir(outputDirectory, { recursive: true });
const backend = Deno.env.get("VOICE_TEST_ORIGIN");
const cookie = Deno.env.get("VOICE_TEST_COOKIE");
const apiKey = Deno.env.get("OPENAI_API_KEY");
if (backend ? !cookie : !apiKey) {
	throw new Error(
		"Provide backend origin and Access cookie, or an OpenAI API key for transport-only testing",
	);
}
if (backend) {
	const url = new URL(backend);
	if (
		url.protocol !== "https:" || url.username || url.password ||
		url.pathname !== "/" || url.search || url.hash
	) {
		throw new Error("VOICE_TEST_ORIGIN must be an HTTPS origin");
	}
}
const token = crypto.randomUUID();
const sessions = new Set<string>();
let origin = "";
const json = (data: unknown, status = 200) => Response.json(data, { status });
const remote = async (path: string, payload: unknown) => {
	const response = await fetch(
		backend
			? `${new URL(backend).origin}/api/voice/${path}`
			: `https://api.openai.com/v1/live/${path}`,
		{
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
			headers: backend
				? {
					"Content-Type": "application/json",
					Origin: new URL(backend).origin,
					Cookie: cookie!,
				}
				: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
			body: JSON.stringify(payload),
		},
	);
	if (!response.ok) {
		const value = await response.json().catch(() => null) as {
			error?: { code?: unknown; type?: unknown };
		} | null;
		const code = value?.error?.code;
		const safeCode =
			typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code)
				? ` ${code}`
				: "";
		throw new Error(`Remote request failed (${response.status})${safeCode}`);
	}
	const text = await response.text();
	if (text.length > 128_000) throw new Error("Remote response exceeds limit");
	return text ? JSON.parse(text) : {};
};
const end = async (id: string) => {
	if (!sessions.has(id)) return;
	await remote(
		`sessions/${encodeURIComponent(id)}/${backend ? "end" : "hangup"}`,
		{},
	);
	sessions.delete(id);
};
const html = await Deno.readTextFile(new URL("./index.html", import.meta.url));
const script = await Deno.readTextFile(new URL("./client.js", import.meta.url));
Deno.serve({
	hostname: "127.0.0.1",
	port: 0,
	onListen: ({ port }) => {
		origin = `http://127.0.0.1:${port}`;
		console.log(
			`Open ${origin}. Mode: ${
				backend
					? "authenticated Enchiridion"
					: "direct provider — transport only"
			}. No microphone is accessed.`,
		);
	},
}, async (request) => {
	const url = new URL(request.url);
	if (url.origin !== origin) {
		return new Response("Invalid host", { status: 403 });
	}
	if (request.method === "GET") {
		if (url.pathname === "/") {
			return new Response(html.replace("TEST_TOKEN", token), {
				headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
			});
		}
		if (url.pathname === "/client.js") {
			return new Response(script, {
				headers: { "Content-Type": "text/javascript" },
			});
		}
		if (url.pathname === "/input.wav") {
			return new Response(input, { headers: { "Content-Type": "audio/wav" } });
		}
		return new Response("Not found", { status: 404 });
	}
	if (
		request.method !== "POST" || request.headers.get("origin") !== origin ||
		request.headers.get("x-test-token") !== token
	) return json({ error: "Forbidden" }, 403);
	try {
		if (url.pathname === "/session") {
			if (sessions.size) {
				return json({ error: "A test session is already active" }, 409);
			}
			const body = await request.json() as Record<string, unknown>;
			if (
				typeof body.sdp !== "string" || body.sdp.length > 60_000 ||
				!body.sdp.startsWith("v=0")
			) return json({ error: "Invalid SDP" }, 400);
			const response = await remote(
				"sessions",
				backend
					? {
						sdp: body.sdp,
						device: "iphone",
						requestID: crypto.randomUUID(),
						timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					}
					: {
						session: {
							model: "gpt-live-1",
							store: false,
							instructions:
								"This is a synthetic-audio transport test. Respond briefly to the caller. You have no application tools or private user data.",
						},
						transport: { type: "webrtc", sdp: body.sdp },
					},
			);
			if (
				typeof response.session?.id !== "string" ||
				typeof response.transport?.sdp !== "string"
			) throw new Error("Invalid session answer");
			const id = response.session.id;
			sessions.add(id);
			setTimeout(() => {
				end(id).catch(() =>
					console.error("Timed test hangup was not confirmed")
				);
			}, 90_000);
			return json(response);
		}
		if (url.pathname === "/end") {
			const { id } = await request.json() as Record<string, unknown>;
			if (typeof id !== "string" || !sessions.has(id)) {
				return json({ state: "not-owned" }, 404);
			}
			await end(id);
			return json({ state: "closed" });
		}
		if (url.pathname === "/result") {
			const body = new Uint8Array(await request.arrayBuffer());
			if (body.length > 16_000_000) throw new Error("Output exceeds limit");
			await Deno.writeFile(`${outputDirectory}/remote-audio.webm`, body);
			return json({ saved: true });
		}
		if (url.pathname === "/events") {
			const text = await request.text();
			if (text.length > 1_000_000) throw new Error("Events exceed limit");
			const events = JSON.parse(text);
			await Deno.writeTextFile(
				`${outputDirectory}/events.json`,
				JSON.stringify(events, null, 2),
			);
			return json({ saved: true });
		}
		return json({ error: "Not found" }, 404);
	} catch (error) {
		return json({
			error: error instanceof Error ? error.message : "Test failed",
		}, 502);
	}
});

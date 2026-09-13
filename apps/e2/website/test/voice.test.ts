import { expect } from "expect";
import { forwardVoiceRequest } from "../src/lib/voice.ts";

const origin = "https://apsides.rawkode.academy";

Deno.test("voice proxy preserves protocol authentication without forwarding ambient credentials", async () => {
	const request = new Request(`${origin}/api/voice/sessions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: origin,
			"Cf-Access-Jwt-Assertion": "verified-at-worker",
			Cookie: "private-cookie",
			Authorization: "Bearer unrelated-token",
			"X-E2-Owner": "spoofed-owner",
		},
		body: JSON.stringify({
			sdp: "v=0",
			device: "iphone",
			requestID: "request",
		}),
	});
	let calls = 0;
	const response = await forwardVoiceRequest(request, {
		fetch: async (input: RequestInfo | URL) => {
			calls++;
			const forwarded = input as Request;
			expect(forwarded.url).toBe(request.url);
			expect(forwarded.headers.get("Origin")).toBe(origin);
			expect(forwarded.headers.get("Cf-Access-Jwt-Assertion")).toBe(
				"verified-at-worker",
			);
			for (const name of ["Cookie", "Authorization", "X-E2-Owner"]) {
				expect(forwarded.headers.has(name)).toBe(false);
			}
			expect(await forwarded.json()).toEqual({
				sdp: "v=0",
				device: "iphone",
				requestID: "request",
			});
			return Response.json({ error: "Voice is not configured" }, {
				status: 503,
			});
		},
	});
	expect(calls).toBe(1);
	expect(response.status).toBe(503);
});

Deno.test("voice proxy does not expose unrecognized worker routes or methods", async () => {
	const binding = {
		fetch: () => {
			throw new Error("Must not forward");
		},
	};
	for (const path of ["admin", "sessions/id/admin", "sessions/id/end/extra"]) {
		const response = await forwardVoiceRequest(
			new Request(`${origin}/api/voice/${path}`, { method: "POST" }),
			binding,
		);
		expect(response.status).toBe(404);
	}
	expect(
		(await forwardVoiceRequest(
			new Request(`${origin}/api/voice/sessions`),
			binding,
		)).status,
	).toBe(405);
});

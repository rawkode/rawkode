import { expect } from "expect";
import { authenticate, sameOriginPost } from "../src/lib/auth.ts";
import { readForm, requiredField } from "../src/lib/forms.ts";

const origin = "https://apsides.rawkode.academy";
const config = {
	WEBSITE_ORIGIN: origin,
	ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
	ACCESS_AUDIENCE: "audience",
	ADMIN_EMAILS: "david@rawkode.academy",
};

Deno.test("website rejects spoofed identities and alternate origins", async () => {
	expect(
		await authenticate(
			new Request(origin, {
				headers: {
					"X-E2-Owner": "access:admin",
					"Cf-Access-Authenticated-User-Email": "david@rawkode.academy",
				},
			}),
			config,
		),
	).toBeNull();
	expect(
		await authenticate(
			new Request("https://other.example", {
				headers: { "Cf-Access-Jwt-Assertion": "spoofed" },
			}),
			config,
		),
	).toBeNull();
	expect(
		await authenticate(
			new Request(origin, {
				headers: { "Cf-Access-Jwt-Assertion": "spoofed" },
			}),
			{ ...config, ACCESS_TEAM_DOMAIN: "attacker.example" },
		),
	).toBeNull();
});

Deno.test("website mutation boundary requires a same-origin POST", () => {
	expect(
		sameOriginPost(
			new Request(origin, { method: "POST", headers: { Origin: origin } }),
			origin,
		),
	).toBe(true);
	for (
		const request of [
			new Request(origin),
			new Request(origin, { method: "POST" }),
			new Request(origin, {
				method: "POST",
				headers: { Origin: "https://other.example" },
			}),
			new Request(origin, {
				method: "POST",
				headers: { Origin: origin, "Sec-Fetch-Site": "cross-site" },
			}),
		]
	) expect(sameOriginPost(request, origin)).toBe(false);
});

Deno.test("forms reject duplicate identity fields and oversized chunked bodies", async () => {
	expect(() =>
		requiredField(
			new URLSearchParams("connectionId=a&connectionId=b"),
			"connectionId",
		)
	).toThrow();
	const request = new Request(origin, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new ReadableStream({
			start: (controller) => {
				controller.enqueue(
					new TextEncoder().encode("connectionId=" + "x".repeat(4096)),
				);
				controller.close();
			},
		}),
	});
	await expect(readForm(request)).rejects.toThrow("Form too large");
	const form = await readForm(
		new Request(origin, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "connectionId=account&action=sync",
		}),
	);
	expect(requiredField(form, "connectionId")).toBe("account");
});

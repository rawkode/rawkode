import { describe, expect, it } from "vitest";
import { authenticate, requirePrincipal } from "../src/lib/auth";
import type { Env } from "../src/lib/types";

function testEnv(overrides: Partial<Env> = {}): Env {
	return overrides as Env;
}

describe("authentication", () => {
	it("accepts a Cloudflare Access principal when the email is allowed", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				"cf-access-authenticated-user-email": "rawkode@example.com",
				"cf-access-authenticated-user-name": "Rawkode",
			},
		});

		expect(authenticate(request, testEnv({ ALLOWED_EMAILS: "rawkode@example.com" }))).toEqual({
			email: "rawkode@example.com",
			name: "Rawkode",
			source: "cloudflare-access",
		});
	});

	it("rejects a Cloudflare Access principal when the email is not allowed", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				"cf-access-authenticated-user-email": "someone@example.com",
			},
		});

		expect(authenticate(request, testEnv({ ALLOWED_EMAILS: "rawkode@example.com" }))).toBeNull();
	});

	it("does not use the dev identity on production hosts", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap");

		expect(authenticate(request, testEnv({ DEV_USER_EMAIL: "rawkode.local" }))).toBeNull();
	});

	it("uses the dev identity only for local development hosts", () => {
		const request = new Request("http://localhost:8787/api/bootstrap");

		expect(authenticate(request, testEnv({ DEV_USER_EMAIL: "rawkode.local" }))).toEqual({
			email: "rawkode.local",
			name: "rawkode.local",
			source: "dev",
		});
	});

	it("throws a JSON 401 response when no principal is available", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap");

		expect(() => requirePrincipal(request, testEnv())).toThrow(Response);
	});
});

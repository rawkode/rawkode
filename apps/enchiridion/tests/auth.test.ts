import { describe, expect, it } from "vitest";
import { authenticate, requirePrincipal } from "../src/lib/auth";
import type { Env } from "../src/lib/types";

function testEnv(overrides: Partial<Env> = {}): Env {
	return overrides as Env;
}

describe("authentication", () => {
	it("accepts a Cloudflare Access principal only when header trust and an email allowlist are configured", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				"cf-access-authenticated-user-email": "rawkode@example.com",
				"cf-access-authenticated-user-name": "Rawkode",
			},
		});

		expect(authenticate(request, testEnv({
			ALLOWED_EMAILS: "rawkode@example.com",
			TRUST_CLOUDFLARE_ACCESS_HEADERS: "true",
		}))).toEqual({
			email: "rawkode@example.com",
			name: "Rawkode",
			source: "cloudflare-access",
		});
	});

	it("ignores Cloudflare Access headers unless explicitly trusted", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				"cf-access-authenticated-user-email": "rawkode@example.com",
			},
		});

		expect(authenticate(request, testEnv({ ALLOWED_EMAILS: "rawkode@example.com" }))).toBeNull();
		expect(authenticate(request, testEnv({ TRUST_CLOUDFLARE_ACCESS_HEADERS: "true" }))).toBeNull();
	});

	it("rejects a Cloudflare Access principal when the email is not allowed", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				"cf-access-authenticated-user-email": "someone@example.com",
			},
		});

		expect(authenticate(request, testEnv({
			ALLOWED_EMAILS: "rawkode@example.com",
			TRUST_CLOUDFLARE_ACCESS_HEADERS: "true",
		}))).toBeNull();
	});

	it("accepts the configured app password via Basic auth", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				authorization: `Basic ${btoa("rawkode:secret-password")}`,
			},
		});

		expect(authenticate(request, testEnv({ ENCHIRIDION_PASSWORD: "secret-password" }))).toEqual({
			email: "rawkode@password.enchiridion.local",
			name: "rawkode",
			source: "password",
		});
	});

	it("uses Basic auth when untrusted Cloudflare Access headers are present", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				authorization: `Basic ${btoa("rawkode:secret-password")}`,
				"cf-access-authenticated-user-email": "attacker@example.com",
			},
		});

		expect(authenticate(request, testEnv({
			ALLOWED_EMAILS: "attacker@example.com",
			ENCHIRIDION_PASSWORD: "secret-password",
		}))).toEqual({
			email: "rawkode@password.enchiridion.local",
			name: "rawkode",
			source: "password",
		});
	});

	it("rejects missing or incorrect app password credentials", () => {
		const unauthenticated = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap");
		const incorrect = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap", {
			headers: {
				authorization: `Basic ${btoa("rawkode:wrong")}`,
			},
		});

		expect(authenticate(unauthenticated, testEnv({ ENCHIRIDION_PASSWORD: "secret-password" }))).toBeNull();
		expect(authenticate(incorrect, testEnv({ ENCHIRIDION_PASSWORD: "secret-password" }))).toBeNull();
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

	it("challenges browsers with Basic auth when no principal is available", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/bootstrap");

		try {
			requirePrincipal(request, testEnv());
		} catch (error) {
			expect(error).toBeInstanceOf(Response);
			expect((error as Response).status).toBe(401);
			expect((error as Response).headers.get("www-authenticate")).toBe('Basic realm="Enchiridion", charset="UTF-8"');
		}
	});
});

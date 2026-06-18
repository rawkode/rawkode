import { describe, expect, it } from "vitest";
import {
	buildWorkerSecretPayload,
	deriveHostSigningSecret,
	requiredWorkerSecretNames,
} from "../scripts/worker-secrets.mjs";

describe("worker secret payload", () => {
	it("declares every required production Worker secret", () => {
		expect(requiredWorkerSecretNames).toEqual([
			"CLOUDFLARE_API_TOKEN",
			"ENCHIRIDION_PASSWORD",
			"HOST_SIGNING_SECRET",
		]);
	});

	it("derives host signing material from the explicit host seed", () => {
		const payload = buildWorkerSecretPayload({
			CLOUDFLARE_API_TOKEN: "cf-token",
			ENCHIRIDION_PASSWORD: "app-password",
			HOST_SIGNING_SECRET: "host-signing-seed",
		});

		expect(payload.CLOUDFLARE_API_TOKEN).toBe("cf-token");
		expect(payload.ENCHIRIDION_PASSWORD).toBe("app-password");
		expect(payload.HOST_SIGNING_SECRET).toMatch(/^[a-f0-9]{64}$/);
		expect(payload.HOST_SIGNING_SECRET).toBe(deriveHostSigningSecret("host-signing-seed"));
		expect(payload.HOST_SIGNING_SECRET).not.toBe("host-signing-seed");
		expect(payload.HOST_SIGNING_SECRET).not.toBe("app-password");
	});

	it("does not fall back to the app password for host signing material", () => {
		expect(() => buildWorkerSecretPayload({
			CLOUDFLARE_API_TOKEN: "cf-token",
			ENCHIRIDION_PASSWORD: "app-password",
		})).toThrow("HOST_SIGNING_SECRET required to sync Enchiridion Worker secrets.");
	});

	it("reports every missing secret in one failure", () => {
		expect(() => buildWorkerSecretPayload({})).toThrow(
			"CLOUDFLARE_API_TOKEN, ENCHIRIDION_PASSWORD, HOST_SIGNING_SECRET required to sync Enchiridion Worker secrets.",
		);
	});
});

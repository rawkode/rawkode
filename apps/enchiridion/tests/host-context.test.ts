import { describe, expect, it } from "vitest";
import {
	requireHostApiContext,
	requireHostSigningSecret,
	signHostContext,
	verifyHostContext,
} from "../src/lib/host-context";
import type { Env } from "../src/lib/types";

describe("host context signing secrets", () => {
	it("uses the configured runtime secret", () => {
		expect(requireHostSigningSecret({ HOST_SIGNING_SECRET: "configured-secret" } as Env)).toBe("configured-secret");
	});

	it("allows the dev fallback only on local requests", () => {
		const request = new Request("http://localhost:8787/api/host-context");

		expect(requireHostSigningSecret({} as Env, request)).toBe("dev-host-signing-secret");
	});

	it("rejects missing production signing material", () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/host-context");

		expect(() => requireHostSigningSecret({} as Env, request)).toThrow(Response);
	});

	it("signs and verifies host context payloads", async () => {
		const token = await signHostContext({
			app: "hello-world",
			scopes: ["notes:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/hello-world" },
		}, "configured-secret");

		expect(await verifyHostContext(token, "configured-secret")).toMatchObject({
			app: "hello-world",
			scopes: ["notes:read"],
			context: { path: "/apps/hello-world" },
		});
		expect(await verifyHostContext(token, "wrong-secret")).toBeNull();
	});

	it("authorizes host API calls with the required scope", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search", {
			headers: { "x-enchiridion-host-context": token },
		});

		await expect(requireHostApiContext(
			{ HOST_SIGNING_SECRET: "configured-secret" } as Env,
			request,
			"resource-index:read",
		)).resolves.toMatchObject({
			app: "search-app",
			scopes: ["resource-index:read"],
		});
	});

	it("rejects host API calls without a host context token", async () => {
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search");

		await expect(requireHostApiContext(
			{ HOST_SIGNING_SECRET: "configured-secret" } as Env,
			request,
			"resource-index:read",
		)).rejects.toMatchObject({ status: 401 });
	});

	it("rejects host API calls without the required scope", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["notes:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const request = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search", {
			headers: { "x-enchiridion-host-context": token },
		});

		await expect(requireHostApiContext(
			{ HOST_SIGNING_SECRET: "configured-secret" } as Env,
			request,
			"resource-index:read",
		)).rejects.toMatchObject({ status: 403 });
	});

	it("rejects host API calls with invalid or malformed tokens", async () => {
		const invalidSignature = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: {},
		}, "wrong-secret");
		const invalidSignatureRequest = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search", {
			headers: { "x-enchiridion-host-context": invalidSignature },
		});
		const malformedRequest = new Request("https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search", {
			headers: { "x-enchiridion-host-context": "not-a-token" },
		});

		await expect(requireHostApiContext(
			{ HOST_SIGNING_SECRET: "configured-secret" } as Env,
			invalidSignatureRequest,
			"resource-index:read",
		)).rejects.toMatchObject({ status: 401 });
		await expect(requireHostApiContext(
			{ HOST_SIGNING_SECRET: "configured-secret" } as Env,
			malformedRequest,
			"resource-index:read",
		)).rejects.toMatchObject({ status: 401 });
	});
});

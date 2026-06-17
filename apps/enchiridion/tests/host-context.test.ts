import { describe, expect, it } from "vitest";
import { requireHostSigningSecret, signHostContext, verifyHostContext } from "../src/lib/host-context";
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
});

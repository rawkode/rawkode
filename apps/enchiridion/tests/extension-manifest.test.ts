import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "../src/lib/extension-manifest";
import { builtinExtensionManifests } from "../src/lib/seed";

describe("extension manifest validation", () => {
	it("accepts the built-in mini app manifests", () => {
		for (const manifest of builtinExtensionManifests) {
			const result = validateExtensionManifest(manifest);
			expect(result.issues).toEqual([]);
			expect(result.ok).toBe(true);
		}
	});

	it("rejects routes outside the app namespace", () => {
		const result = validateExtensionManifest({
			...builtinExtensionManifests[0],
			slug: "reader",
			routes: [{ path: "/admin", mode: "worker-page", label: "Admin" }],
			commands: [],
			editorBlocks: [],
			hostApis: [],
			bindings: [],
			indexProjections: [],
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("routes./admin: route must stay under /apps/reader");
	});

	it("requires commands and blocks to declare their host APIs", () => {
		const result = validateExtensionManifest({
			...builtinExtensionManifests[0],
			slug: "capture",
			routes: [{ path: "/apps/capture", mode: "worker-page", label: "Capture" }],
			commands: [{
				id: "create-capture",
				label: "Create capture",
				description: "Create a capture.",
				kind: "create",
				scope: "global",
				app: "capture",
				action: "capture.create",
				requiredHostApis: ["notes:write"],
			}],
			editorBlocks: [{
				id: "capture-list",
				app: "capture",
				label: "Capture list",
				description: "Show captures.",
				defaultProps: {},
				renderer: "host-primitive",
				requiredHostApis: ["resource-index:read"],
			}],
			hostApis: [],
			bindings: [],
			indexProjections: [],
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("commands.create-capture: required host API notes:write is not declared");
		expect(result.issues).toContain("editorBlocks.capture-list: required host API resource-index:read is not declared");
	});
});

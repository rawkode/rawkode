import { describe, expect, it } from "vitest";
import { auditDetailSummary, auditToneForStatus } from "../src/lib/audit";

describe("mini app audit helpers", () => {
	it("maps workflow statuses to semantic tones", () => {
		expect(auditToneForStatus("deployed")).toBe("success");
		expect(auditToneForStatus("requires_binding_provisioning")).toBe("warning");
		expect(auditToneForStatus("validation_failed")).toBe("danger");
		expect(auditToneForStatus("queued")).toBe("neutral");
	});

	it("summarizes direct messages first", () => {
		expect(auditDetailSummary({
			message: "Mini app Worker deployed.",
			issues: ["ignored"],
		})).toBe("Mini app Worker deployed.");
	});

	it("summarizes validation and attempt failures", () => {
		expect(auditDetailSummary({
			validation: { message: "Smoke test failed with 500: Load failed" },
		})).toBe("Smoke test failed with 500: Load failed");

		expect(auditDetailSummary({
			attempts: [
				{ message: "first" },
				{ message: "Cloudflare upload failed with 400: parse error" },
			],
		})).toBe("Cloudflare upload failed with 400: parse error");
	});

	it("joins issue lists for rejected runs", () => {
		expect(auditDetailSummary({
			issues: [
				"manifest.slug: hello-world already exists; use update instead",
				"bindings: autonomous deploy cannot provision isolated bindings yet",
			],
		})).toBe("manifest.slug: hello-world already exists; use update instead bindings: autonomous deploy cannot provision isolated bindings yet");
	});
});

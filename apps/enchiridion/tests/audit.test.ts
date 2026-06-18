import { describe, expect, it } from "vitest";
import { auditDetailSummary, auditToneForStatus } from "../src/lib/audit";

describe("mini app audit helpers", () => {
	it("maps workflow statuses to semantic tones", () => {
		expect(auditToneForStatus("deployed")).toBe("success");
		expect(auditToneForStatus("admitted")).toBe("success");
		expect(auditToneForStatus("completed")).toBe("success");
		expect(auditToneForStatus("enabled")).toBe("success");
		expect(auditToneForStatus("requires_binding_provisioning")).toBe("warning");
		expect(auditToneForStatus("deployed_pending")).toBe("warning");
		expect(auditToneForStatus("update_deferred")).toBe("warning");
		expect(auditToneForStatus("validation_failed")).toBe("danger");
		expect(auditToneForStatus("queued")).toBe("neutral");
		expect(auditToneForStatus("disabled")).toBe("neutral");
	});

	it("summarizes direct messages first", () => {
		expect(auditDetailSummary({
			message: "Mini app Worker deployed.",
			issues: ["ignored"],
		})).toBe("Mini app Worker deployed.");
	});

	it("summarizes scheduled workflow details", () => {
		expect(auditDetailSummary({
			runId: "run-123",
			scheduledAt: "2026-06-18T12:10:00.000Z",
			workflowId: "rss-reader:refresh-feeds",
		}, "admitted")).toBe("Run run-123 for rss-reader:refresh-feeds admitted at 2026-06-18T12:10:00.000Z.");

		expect(auditDetailSummary({
			enabled: false,
		}, "disabled")).toBe("Schedule disabled.");

		expect(auditDetailSummary({
			error: "Dispatch namespace binding is not configured.",
			scheduledAt: "2026-06-18T12:10:00.000Z",
			workflowId: "rss-reader:refresh-feeds",
		}, "failed")).toBe("Dispatch namespace binding is not configured. rss-reader:refresh-feeds scheduled at 2026-06-18T12:10:00.000Z.");
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

	it("surfaces validation retry context for successful deployments", () => {
		expect(auditDetailSummary({
			message: "Mini app Worker deployed.",
			validationAttempts: [
				{ attempt: 1, status: "failed", message: "Load failed" },
				{ attempt: 2, status: "passed", message: "Primary mini-app route rendered successfully." },
			],
		}, "deployed")).toBe("Mini app Worker deployed. Validation passed after 2 attempts.");
	});

	it("surfaces superseded Worker cleanup for successful updates", () => {
		expect(auditDetailSummary({
			message: "Mini app Worker deployed.",
			supersededScriptCleanup: {
				scriptName: "enchiridion-hello-world-old",
				deleted: true,
				message: "Mini app Worker candidate removed.",
			},
		}, "updated")).toBe("Mini app Worker deployed. Superseded Worker enchiridion-hello-world-old removed.");
	});
});

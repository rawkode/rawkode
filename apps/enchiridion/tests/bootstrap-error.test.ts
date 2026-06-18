import { describe, expect, it } from "vitest";
import { formatBootstrapLoadError } from "../src/lib/bootstrap-error";

describe("formatBootstrapLoadError", () => {
	it("turns browser fetch failures into an actionable startup message", () => {
		expect(formatBootstrapLoadError(new TypeError("Failed to fetch"))).toBe(
			"The app shell could not reach the Enchiridion API.",
		);
	});

	it("keeps HTTP status failures specific", () => {
		expect(formatBootstrapLoadError(new Error("Failed to load Enchiridion: 500"))).toBe(
			"Failed to load Enchiridion: 500",
		);
	});

	it("falls back when the error has no message", () => {
		expect(formatBootstrapLoadError(null)).toBe("Enchiridion could not load its startup data.");
	});
});

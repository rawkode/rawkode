import { describe, expect, it } from "vitest";
import { cronMatches } from "../src/lib/cron";

const at = (iso: string) => new Date(iso);

describe("cron matching", () => {
	it("matches exact minute and hour in UTC", () => {
		expect(cronMatches("30 7 * * *", at("2026-06-18T07:30:00.000Z"))).toBe(true);
		expect(cronMatches("30 7 * * *", at("2026-06-18T07:31:00.000Z"))).toBe(false);
	});

	it("matches steps, lists, and ranges", () => {
		expect(cronMatches("*/15 7-9 * * 1,4", at("2026-06-18T08:45:00.000Z"))).toBe(true);
		expect(cronMatches("*/15 7-9 * * 1,4", at("2026-06-18T08:40:00.000Z"))).toBe(false);
		expect(cronMatches("*/15 7-9 * * 1,4", at("2026-06-18T10:45:00.000Z"))).toBe(false);
	});

	it("treats Sunday as 0 or 7", () => {
		expect(cronMatches("0 12 * * 0", at("2026-06-21T12:00:00.000Z"))).toBe(true);
		expect(cronMatches("0 12 * * 7", at("2026-06-21T12:00:00.000Z"))).toBe(true);
	});

	it("rejects malformed expressions", () => {
		expect(cronMatches("* * *", at("2026-06-18T12:00:00.000Z"))).toBe(false);
		expect(cronMatches("*/0 * * * *", at("2026-06-18T12:00:00.000Z"))).toBe(false);
		expect(cronMatches("99 * * * *", at("2026-06-18T12:00:00.000Z"))).toBe(false);
	});
});

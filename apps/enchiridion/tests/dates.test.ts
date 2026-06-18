import { describe, expect, it } from "vitest";
import { titleForDailyNote } from "../src/lib/dates";

describe("date formatting", () => {
	it("formats daily note titles as human-readable dates", () => {
		expect(titleForDailyNote("2026-06-01")).toBe("1st June, 2026");
		expect(titleForDailyNote("2026-06-02")).toBe("2nd June, 2026");
		expect(titleForDailyNote("2026-06-03")).toBe("3rd June, 2026");
		expect(titleForDailyNote("2026-06-04")).toBe("4th June, 2026");
		expect(titleForDailyNote("2026-06-11")).toBe("11th June, 2026");
		expect(titleForDailyNote("2026-06-12")).toBe("12th June, 2026");
		expect(titleForDailyNote("2026-06-13")).toBe("13th June, 2026");
		expect(titleForDailyNote("2026-06-19")).toBe("19th June, 2026");
	});
});

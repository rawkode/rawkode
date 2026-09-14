import {
	layoutDayEvents,
	type TodayEvent,
} from "../src/editor/todayContext.ts";

const event = (id: string, start: string, end: string): TodayEvent => ({
	id,
	start,
	end,
	connectionId: "test",
	calendarId: "work",
	calendarName: "Work",
	summary: id,
	recurringEventId: null,
	attendees: [],
});
const assert = (condition: boolean, message: string) => {
	if (!condition) throw new Error(message);
};
Deno.test("calendar allocates columns across transitive overlaps and releases them for adjacent events", () => {
	const slots = layoutDayEvents([
		event("a", "2026-09-12T10:00:00", "2026-09-12T11:00:00"),
		event("b", "2026-09-12T10:30:00", "2026-09-12T11:30:00"),
		event("c", "2026-09-12T11:00:00", "2026-09-12T12:00:00"),
		event("d", "2026-09-12T12:00:00", "2026-09-12T13:00:00"),
	], "2026-09-12");
	assert(
		slots.map((slot) => slot.column).join() === "0,1,0,0",
		"non-overlapping appointments reuse columns",
	);
	assert(
		slots.map((slot) => slot.columns).join() === "2,2,2,1",
		"transitive overlap group shares width",
	);
});
Deno.test("calendar clips spanning events and excludes all-day or unrelated days", () => {
	const slots = layoutDayEvents([
		event("overnight", "2026-09-11T23:00:00", "2026-09-12T01:00:00"),
		event("late", "2026-09-12T23:00:00", "2026-09-13T02:00:00"),
		event("all-day", "2026-09-12", "2026-09-13"),
		event("yesterday", "2026-09-11T10:00:00", "2026-09-11T11:00:00"),
	], "2026-09-12");
	assert(
		slots.length === 2,
		"only timed events in the selected day enter the timeline",
	);
	assert(
		slots[0]!.start === 0 && slots[0]!.end === 60,
		"overnight start clipped",
	);
	assert(
		slots[1]!.start === 1380 && slots[1]!.end === 1440,
		"overnight end clipped",
	);
});
Deno.test("short appointments reserve their rendered height when allocating columns", () => {
	const slots = layoutDayEvents([
		event("a", "2026-09-12T10:00:00", "2026-09-12T10:15:00"),
		event("b", "2026-09-12T10:15:00", "2026-09-12T10:30:00"),
	], "2026-09-12");
	assert(
		slots[0]!.columns === 2 && slots[1]!.column === 1,
		"short adjacent events must not visually cover each other",
	);
});

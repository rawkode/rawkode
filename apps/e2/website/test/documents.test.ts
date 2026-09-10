import { expect } from "expect";
import { parseNote } from "@e2/documents/note";
import {
	createDocumentSaver,
	type SaveState,
	todayDocumentId,
} from "../src/editor/documents.ts";
import {
	eventDocumentId,
	eventSeriesDocumentId,
	eventSeriesDocumentPrefix,
} from "../src/editor/eventDocuments.ts";

const note = (text: string) =>
	parseNote({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const saved = (revision: number) =>
	Response.json({
		document: {
			id: "daily:2026-09-10",
			note: note("saved"),
			revision,
			updatedAt: "2026-09-10T12:00:00Z",
		},
	});

Deno.test("today ID uses the local calendar date", () => {
	expect(todayDocumentId(new Date(2026, 0, 2, 0, 5))).toBe("daily:2026-01-02");
});

Deno.test("event document IDs include the calendar and remain bounded for opaque IDs", () => {
	const calendar = "calendar-a";
	const series = "x".repeat(1_024);
	const event = "x".repeat(1_024);
	const first = eventDocumentId("connection", calendar, event, series);
	const second = eventDocumentId("connection", "calendar-b", event, series);
	const punctuation = eventDocumentId(
		"connection",
		"a.b@gmail.com",
		event,
		series,
	);
	const underscore = eventDocumentId(
		"connection",
		"a_b@gmail.com",
		event,
		series,
	);
	expect(first).not.toBe(second);
	expect(punctuation).not.toBe(underscore);
	expect(first.length).toBeLessThanOrEqual(128);
	expect(eventSeriesDocumentId("connection", calendar, series)).toContain(
		"event-series:connection:calendar-a:",
	);
	expect(eventSeriesDocumentPrefix("connection", calendar, series)).toMatch(
		/^event:connection:calendar-a:[a-zA-Z0-9_-]+:$/,
	);
});

Deno.test("opening a blank daily note does not create it; edits serialize against the returned revision", async () => {
	const requests: { note: unknown; expectedRevision: number | null }[] = [];
	let finish!: (response: Response) => void;
	const saver = createDocumentSaver({
		id: "daily:2026-09-10",
		revision: null,
		delay: 0,
		onState: () => {},
		request: (_input, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return requests.length === 1
				? new Promise((resolve) => {
					finish = resolve;
				})
				: Promise.resolve(saved(2));
		},
	});
	await tick();
	expect(requests).toHaveLength(0);
	expect(saver.hasUnsavedChanges()).toBe(false);
	saver.schedule(note("first edit"));
	await tick();
	saver.schedule(note("second edit"));
	await tick();
	expect(requests).toHaveLength(1);
	finish(saved(1));
	await tick();
	expect(requests.map(({ expectedRevision }) => expectedRevision)).toEqual([
		null,
		1,
	]);
	expect(requests[1].note).toEqual(note("second edit"));
	expect(saver.hasUnsavedChanges()).toBe(false);
	saver.dispose();
});

Deno.test("conflicting saves retain edits and cannot automatically overwrite another tab", async () => {
	let calls = 0;
	const states: SaveState[] = [];
	const saver = createDocumentSaver({
		id: "daily:2026-09-10",
		revision: 1,
		delay: 0,
		onState: (state) => states.push(state),
		request: () => {
			calls++;
			return Promise.resolve(new Response(null, { status: 409 }));
		},
	});
	saver.schedule(note("my edit"));
	await tick();
	expect(states.at(-1)).toBe("conflict");
	saver.schedule(note("further edit"));
	saver.retry();
	await tick();
	expect(calls).toBe(1);
	expect(saver.hasUnsavedChanges()).toBe(true);
	saver.dispose();
});

Deno.test("failed saves retain the latest edit for explicit retry", async () => {
	let calls = 0;
	const requests: unknown[] = [];
	const saver = createDocumentSaver({
		id: "daily:2026-09-10",
		revision: 1,
		delay: 0,
		onState: () => {},
		request: (_input, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return ++calls === 1
				? Promise.reject(new Error("offline"))
				: Promise.resolve(saved(2));
		},
	});
	saver.schedule(note("first edit"));
	await tick();
	saver.schedule(note("latest edit"));
	saver.retry();
	await tick();
	expect(requests[1]).toEqual({
		note: note("latest edit"),
		expectedRevision: 1,
	});
	expect(saver.hasUnsavedChanges()).toBe(false);
	saver.dispose();
});

Deno.test("explicit flush saves immediately and waits for edits queued during the write", async () => {
	const requests: { note: unknown; expectedRevision: number | null }[] = [];
	let finish!: (response: Response) => void;
	const saver = createDocumentSaver({
		id: "daily:2026-09-10",
		revision: null,
		delay: 60_000,
		onState: () => {},
		request: (_input, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return requests.length === 1
				? new Promise((resolve) => {
					finish = resolve;
				})
				: Promise.resolve(saved(2));
		},
	});
	saver.schedule(note("first edit"));
	const transition = saver.flush();
	await tick();
	expect(requests).toHaveLength(1);
	saver.schedule(note("second edit"));
	finish(saved(1));
	expect(await transition).toBe(true);
	expect(requests.map(({ expectedRevision }) => expectedRevision)).toEqual([
		null,
		1,
	]);
	expect(requests[1].note).toEqual(note("second edit"));
	expect(saver.hasUnsavedChanges()).toBe(false);
	saver.dispose();
});

Deno.test("explicit flush blocks transitions after an error or conflict", async () => {
	for (
		const response of [
			() => Promise.reject(new Error("offline")),
			() => Promise.resolve(new Response(null, { status: 409 })),
		]
	) {
		const saver = createDocumentSaver({
			id: "daily:2026-09-10",
			revision: 1,
			delay: 60_000,
			onState: () => {},
			request: response,
		});
		saver.schedule(note("unsaved"));
		expect(await saver.flush()).toBe(false);
		expect(saver.hasUnsavedChanges()).toBe(true);
		saver.dispose();
	}
});

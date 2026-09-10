import { strict as assert } from "node:assert";
import {
	createPaneNavigator,
	encodePane,
	type PaneDescriptor,
	type PaneHistoryMode,
	paneSearchParams,
	parsePaneStack,
} from "../src/editor/paneStack.ts";

const root: PaneDescriptor = { kind: "document", id: "daily:2026-09-10" };
const first: PaneDescriptor = {
	kind: "entity",
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const second: PaneDescriptor = {
	kind: "entity",
	id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

Deno.test("pane URL codec preserves a validated root and repeated entity panes", () => {
	const params = paneSearchParams(
		new URLSearchParams("view=today&pane=stale"),
		[root, first, second],
	);
	assert.equal(params.get("view"), "today");
	assert.deepEqual(
		params.getAll("pane"),
		[root, first, second].map(encodePane),
	);
	assert.deepEqual(parsePaneStack(params), {
		ok: true,
		panes: [root, first, second],
	});
});

Deno.test("pane URL codec rejects missing roots, invalid order, duplicates, and bounds", () => {
	for (
		const values of [
			[],
			[encodePane(first)],
			[encodePane(root), "document:daily:2026-09-11"],
			[encodePane(root), encodePane(first), encodePane(first)],
			[encodePane(root), "entity:not-a-uuid"],
			[
				encodePane(root),
				...Array.from(
					{ length: 8 },
					(_, index) =>
						`entity:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				),
			],
		]
	) {
		const params = new URLSearchParams();
		values.forEach((value) => params.append("pane", value));
		assert.equal(parsePaneStack(params).ok, false);
	}
	const oversized = new URLSearchParams();
	oversized.append("pane", `document:${"a".repeat(2_049)}`);
	assert.deepEqual(parsePaneStack(oversized), {
		ok: false,
		reason: "too-long",
	});
});

Deno.test("pane navigation truncates from the source and distinguishes push from pop", async () => {
	const commits: { panes: readonly PaneDescriptor[]; mode: PaneHistoryMode }[] =
		[];
	const navigator = createPaneNavigator([root, first], {
		prepareForTransition: () => Promise.resolve(true),
		commit: (panes, mode) => commits.push({ panes, mode }),
	});
	assert.equal(await navigator.openEntity(0, second.id), true);
	assert.deepEqual(navigator.panes, [root, second]);
	assert.equal(commits[0]?.mode, "push");
	assert.equal(await navigator.restore([root, first]), true);
	assert.equal(commits[1]?.mode, "pop");
});

Deno.test("failed editor flush leaves pane and history state unchanged", async () => {
	let commits = 0;
	const navigator = createPaneNavigator([root, first], {
		prepareForTransition: () => Promise.resolve(false),
		commit: () => commits++,
	});
	assert.equal(await navigator.activate(0), false);
	assert.deepEqual(navigator.panes, [root, first]);
	assert.equal(commits, 0);
});

Deno.test("rapid navigation is serialized and the latest same-source intent wins", async () => {
	const releases: (() => void)[] = [];
	const commits: string[][] = [];
	const navigator = createPaneNavigator([root], {
		prepareForTransition: () =>
			new Promise<boolean>((resolve) => releases.push(() => resolve(true))),
		commit: (panes) => commits.push(panes.map(encodePane)),
	});
	const openFirst = navigator.openEntity(0, first.id);
	const openSecond = navigator.openEntity(0, second.id);
	await Promise.resolve();
	releases.shift()?.();
	assert.equal(await openFirst, true);
	await Promise.resolve();
	releases.shift()?.();
	assert.equal(await openSecond, true);
	assert.deepEqual(navigator.panes, [root, second]);
	assert.deepEqual(commits, [
		[root, first].map(encodePane),
		[root, second].map(encodePane),
	]);
});

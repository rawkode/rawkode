import { describe, expect, it } from "vitest";
import { closeAppPanelTab, openAppPanelTab } from "../src/lib/app-panel-tabs";

describe("app panel tabs", () => {
	it("keeps the side panel while adding persistent app tabs", () => {
		const withPanel = openAppPanelTab([], {
			mode: "panel",
			route: "/apps/bookmarks",
			title: "Bookmarks",
		});
		const withTab = openAppPanelTab(withPanel.tabs, {
			mode: "tab",
			route: "/apps/projects",
			title: "Projects",
		});

		expect(withTab.activeTabId).toBe("tab:/apps/projects");
		expect(withTab.tabs.map((tab) => tab.id)).toEqual(["panel", "tab:/apps/projects"]);
	});

	it("replaces the temporary side panel without dropping persistent tabs", () => {
		const first = openAppPanelTab([], { mode: "tab", route: "/apps/projects", title: "Projects" });
		const second = openAppPanelTab(first.tabs, { mode: "panel", route: "/apps/bookmarks", title: "Bookmarks" });
		const third = openAppPanelTab(second.tabs, { mode: "panel", route: "/apps/hello", title: "Hello" });

		expect(third.activeTabId).toBe("panel");
		expect(third.tabs).toEqual([
			{ id: "panel", mode: "panel", route: "/apps/hello", title: "Hello" },
			{ id: "tab:/apps/projects", mode: "tab", route: "/apps/projects", title: "Projects" },
		]);
	});

	it("selects the nearest remaining tab when the active tab closes", () => {
		const current = [
			{ id: "panel", mode: "panel" as const, route: "/apps/bookmarks", title: "Bookmarks" },
			{ id: "tab:/apps/projects", mode: "tab" as const, route: "/apps/projects", title: "Projects" },
		];

		expect(closeAppPanelTab(current, "panel", "panel")).toEqual({
			activeTabId: "tab:/apps/projects",
			tabs: [
				{ id: "tab:/apps/projects", mode: "tab", route: "/apps/projects", title: "Projects" },
			],
		});
	});
});

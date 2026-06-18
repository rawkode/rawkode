export type AppPanelMode = "panel" | "tab";

export type AppPanelTab = {
	id: string;
	mode: AppPanelMode;
	route: string;
	title: string;
};

export function openAppPanelTab(
	current: AppPanelTab[],
	input: { mode: AppPanelMode; route: string; title?: string },
): { activeTabId: string; tabs: AppPanelTab[] } {
	const route = input.route.trim();
	const title = input.title?.trim() || route;
	const tab: AppPanelTab = {
		id: input.mode === "panel" ? "panel" : `tab:${route}`,
		mode: input.mode,
		route,
		title,
	};

	if (input.mode === "panel") {
		return {
			activeTabId: tab.id,
			tabs: [tab, ...current.filter((entry) => entry.id !== tab.id)],
		};
	}

	const existingIndex = current.findIndex((entry) => entry.id === tab.id);
	if (existingIndex >= 0) {
		return {
			activeTabId: tab.id,
			tabs: current.map((entry) => entry.id === tab.id ? tab : entry),
		};
	}

	return {
		activeTabId: tab.id,
		tabs: [...current, tab],
	};
}

export function closeAppPanelTab(
	current: AppPanelTab[],
	activeTabId: string | null,
	tabId: string,
): { activeTabId: string | null; tabs: AppPanelTab[] } {
	const closingIndex = current.findIndex((entry) => entry.id === tabId);
	const tabs = current.filter((entry) => entry.id !== tabId);
	if (tabs.length === 0) {
		return { activeTabId: null, tabs };
	}

	if (activeTabId !== tabId) {
		return { activeTabId, tabs };
	}

	const nextIndex = Math.min(closingIndex, tabs.length - 1);
	return {
		activeTabId: tabs[nextIndex]?.id ?? tabs[0]?.id ?? null,
		tabs,
	};
}

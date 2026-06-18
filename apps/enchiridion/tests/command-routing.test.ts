import { describe, expect, it } from "vitest";
import { routeActionForCommand } from "../src/lib/command-routing";
import type { ExtensionCommand } from "../src/lib/types";

const baseCommand: ExtensionCommand = {
	id: "open",
	label: "Open bookmarks",
	description: "Open the app",
	kind: "navigate",
	scope: "global",
	app: "bookmarks",
	action: "/apps/bookmarks",
	requiredHostApis: [],
};

describe("routeActionForCommand", () => {
	it("opens mini-app routes in Enchiridion app tabs", () => {
		expect(routeActionForCommand(baseCommand)).toEqual({
			type: "app-tab",
			route: "/apps/bookmarks",
			title: "Open bookmarks",
		});
	});

	it("leaves non-app navigation as document navigation", () => {
		expect(routeActionForCommand({
			...baseCommand,
			action: "/settings",
		})).toEqual({
			type: "navigate",
			href: "/settings",
		});
	});
});

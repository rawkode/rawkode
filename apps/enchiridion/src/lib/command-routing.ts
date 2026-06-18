import type { ExtensionCommand } from "./types";

export type CommandRouteAction =
	| { type: "app-tab"; route: string; title: string }
	| { type: "navigate"; href: string };

export function routeActionForCommand(command: ExtensionCommand): CommandRouteAction {
	const action = command.action.trim();
	if (action.startsWith("/apps/")) {
		return {
			type: "app-tab",
			route: action,
			title: command.label || action,
		};
	}

	return {
		type: "navigate",
		href: action,
	};
}

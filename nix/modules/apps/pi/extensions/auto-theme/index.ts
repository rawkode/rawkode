/**
 * Syncs pi theme with macOS system appearance.
 * Switches between catppuccin-mocha (dark) and rose-pine-dawn (light)
 * to match Ghostty's configured theme pairing.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);
const POLL_MS = 5_000;

async function isDarkMode(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", async (_event, ctx) => {
		let currentTheme = (await isDarkMode())
			? "catppuccin-mocha"
			: "rose-pine-dawn";
		ctx.ui.setTheme(currentTheme);

		intervalId = setInterval(async () => {
			const newTheme = (await isDarkMode())
				? "catppuccin-mocha"
				: "rose-pine-dawn";
			if (newTheme !== currentTheme) {
				currentTheme = newTheme;
				ctx.ui.setTheme(currentTheme);
			}
		}, POLL_MS);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}

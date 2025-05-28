import { defineModule } from "../../core/module-builder.ts";
import { conditions } from "../../core/conditions.ts";
import { Action, type ActionContext, type SideEffect } from "../../core/action.ts";

const gnomeExtensions = [
	"advanced-alt-tab@G-dH.github.com",
	"blur-my-shell@aunetx",
	"burn-my-windows@schneegans.github.com",
	"caffeine@patapon.info",
	"clipboard-indicator@tudmotu.com",
	"compiz-windows-effect@hermes83.github.com",
	"desktop-cube@schneegans.github.com",
	"emoji-copy@felipeftn",
	"appindicatorsupport@rgcjonas.gmail.com",
	"space-bar@luchrioh",
	"gsconnect@andyholmes.github.io",
	"just-perfection-desktop@just-perfection",
	"transparent-window-moving@noobsai.github.com",
	"grand-theft-focus@zalckos.github.com",
];

const unwantedApps = [
	"gnome-calculator",
	"gnome-console",
	"gnome-maps",
	"gnome-music",
	"gnome-tour",
	"gnome-weather",
];

class DconfImportAction extends Action {
	async plan(context: ActionContext): Promise<SideEffect[]> {
		if (!context.system.desktop.isGnome) {
			return [];
		}
		return [
			{ type: "dconf_write", description: "Import gnome.dconf settings" },
			{ type: "dconf_write", description: "Import keybindings.dconf settings" },
			{ type: "dconf_write", description: "Import mouse.dconf settings" },
			{
				type: "dconf_write",
				description: "Import advanced-alt-tab.dconf settings",
			},
			{
				type: "dconf_write",
				description: "Import burn-my-windows.dconf settings",
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun || !context.system.desktop.isGnome) return;
		const { dconfImport } = await import("../../utils/dconf/mod.ts");
		const moduleDir = context.moduleDir || import.meta.dirname;
		const options = { verbose: context.verbose };
		await dconfImport(`${moduleDir}/gnome.dconf`, "/", options);
		await dconfImport(`${moduleDir}/keybindings.dconf`, "/", options);
		await dconfImport(`${moduleDir}/mouse.dconf`, "/", options);
		await dconfImport(`${moduleDir}/advanced-alt-tab.dconf`, "/", options);
		await dconfImport(`${moduleDir}/burn-my-windows.dconf`, "/", options);
	}
}

class InstallExtensionsAction extends Action {
	async plan(context: ActionContext): Promise<SideEffect[]> {
		if (!context.system.desktop.isGnome) {
			return [];
		}
		return gnomeExtensions.map((ext) => ({
			type: "command_run" as const,
			description: `Install extension ${ext}`,
			target: ext,
		}));
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun || !context.system.desktop.isGnome) return;
		const { runCommand } = await import("../../utils/commands/mod.ts");
		for (const ext of gnomeExtensions) {
			await runCommand("gext", ["install", ext], { verbose: context.verbose });
		}
	}
}

class RemoveUnwantedAppsAction extends Action {
	async plan(context: ActionContext): Promise<SideEffect[]> {
		if (!context.system.desktop.isGnome) {
			return [];
		}
		return [
			{
				type: "command_run" as const,
				description: `Remove apps: ${unwantedApps.join(", ")}`,
				target: "paru",
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun || !context.system.desktop.isGnome) return;
		const { runCommand } = await import("../../utils/commands/mod.ts");
		await runCommand("paru", ["-Rcssun", "--noconfirm", ...unwantedApps], {
			allowFailure: true,
			verbose: context.verbose,
		});
	}
}

export default defineModule("gnome")
	.description("GNOME desktop environment")
	.tags("desktop", "gnome", "ui")
	.when(conditions.isGnome)
	.packageInstall({
		manager: "pacman",
		packages: ["gnome-extensions-cli"],
	})
	.customAction(
		new DconfImportAction(
			"Import dconf settings",
			"Import GNOME dconf settings",
			{},
		),
	)
	.when(conditions.isGnome)
	.symlink({
		source: "bookmarks",
		target: ".config/gtk-3.0/bookmarks",
	})
	.when(conditions.isGnome)
	.symlink({
		source: "burn-my-windows.conf",
		target: ".config/burn-my-windows/profiles/focus.conf",
	})
	.customAction(
		new InstallExtensionsAction(
			"Install GNOME extensions",
			"Install GNOME shell extensions",
			{},
		),
	)
	.customAction(
		new RemoveUnwantedAppsAction(
			"Remove unwanted GNOME apps",
			"Remove unwanted default GNOME applications",
			{},
		),
	)
	.build();

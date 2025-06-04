import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

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

export default defineModule("gnome")
	.description("GNOME desktop environment")
	.with(() => [
		// TODO: Add condition check when(conditions.isGnome) - not yet available in dhd
		packageInstall({
			names: ["gnome-extensions-cli"],
		}),
		// TODO: DconfImportAction - customAction not yet available in dhd
		// customAction(
		// 	new DconfImportAction(
		// 		"Import dconf settings",
		// 		"Import GNOME dconf settings",
		// 		{},
		// 	),
		// ),
		linkDotfile({
			source: "bookmarks",
			target: "gtk-3.0/bookmarks",
		}),
		linkDotfile({
			source: "burn-my-windows.conf",
			target: "burn-my-windows/profiles/focus.conf",
		}),
		// TODO: InstallExtensionsAction - customAction not yet available in dhd
		// customAction(
		// 	new InstallExtensionsAction(
		// 		"Install GNOME extensions",
		// 		"Install GNOME shell extensions",
		// 		{},
		// 	),
		// ),
		// TODO: RemoveUnwantedAppsAction - customAction not yet available in dhd
		// customAction(
		// 	new RemoveUnwantedAppsAction(
		// 		"Remove unwanted GNOME apps",
		// 		"Remove unwanted default GNOME applications",
		// 		{},
		// 	),
		// ),
	]);
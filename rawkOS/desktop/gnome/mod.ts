// TODO
// const gnomeExtensions = [
// 	"advanced-alt-tab@G-dH.github.com",
// 	"blur-my-shell@aunetx",
// 	"burn-my-windows@schneegans.github.com",
// 	"caffeine@patapon.info",
// 	"clipboard-indicator@tudmotu.com",
// 	"compiz-windows-effect@hermes83.github.com",
// 	"desktop-cube@schneegans.github.com",
// 	"emoji-copy@felipeftn",
// 	"appindicatorsupport@rgcjonas.gmail.com",
// 	"space-bar@luchrioh",
// 	"gsconnect@andyholmes.github.io",
// 	"just-perfection-desktop@just-perfection",
// 	"transparent-window-moving@noobsai.github.com",
// 	"grand-theft-focus@zalckos.github.com",
// ];

// const unwantedApps = [
// 	"gnome-calculator",
// 	"gnome-console",
// 	"gnome-maps",
// 	"gnome-music",
// 	"gnome-tour",
// 	"gnome-weather",
// ];

// export default defineModule("gnome")
// 	.description("GNOME desktop environment")
// 	.actions([
// 		// TODO: Add condition check when(conditions.isGnome) - not yet available in dhd
// 		packageInstall({
// 			names: ["gnome-extensions-cli"],
// 		}),
// 		// TODO: DconfImportAction - customAction not yet available in dhd
// 		// customAction(
// 		// 	new DconfImportAction(
// 		// 		"Import dconf settings",
// 		// 		"Import GNOME dconf settings",
// 		// 		{},
// 		// 	),
// 		// ),
// 		linkDotfile({
// 			from: "bookmarks",
// 			to: "gtk-3.0/bookmarks",
// 			force: true,
// 		}),
// 		linkDotfile({
// 			from: "burn-my-windows.conf",
// 			to: "burn-my-windows/profiles/focus.conf",
// 			force: true,
// 		}),
// 		// TODO: InstallExtensionsAction - customAction not yet available in dhd
// 		// customAction(
// 		// 	new InstallExtensionsAction(
// 		// 		"Install GNOME extensions",
// 		// 		"Install GNOME shell extensions",
// 		// 		{},
// 		// 	),
// 		// ),
// 		// TODO: RemoveUnwantedAppsAction - customAction not yet available in dhd
// 		// customAction(
// 		// 	new RemoveUnwantedAppsAction(
// 		// 		"Remove unwanted GNOME apps",
// 		// 		"Remove unwanted default GNOME applications",
// 		// 		{},
// 		// 	),
// 		// ),
// 	]);

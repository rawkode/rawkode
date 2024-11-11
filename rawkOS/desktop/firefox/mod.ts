import { $ } from "zx";
import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "firefox-dev",
		url:
			"https://download.copr.fedorainfracloud.org/results/the4runner/firefox-dev/fedora-$releasever-$basearch/",
		keyUrl:
			"https://download.copr.fedorainfracloud.org/results/the4runner/firefox-dev/pubkey.gpg",
	});

	await installPackages([
		"firefox-dev",
	]);

	await $`mv /var/opt/firefox-dev /usr/lib/firefox-dev`;
	await $`rm /usr/share/icons/hicolor/128x128/apps/firefox-developer-edition.png`;
	await $`cp /usr/lib/firefox-dev/browser/chrome/icons/default/default128.png /usr/share/icons/hicolor/128x128/apps/firefox-developer-edition.png`;

	Deno.writeFileSync(
		"/usr/lib/tmpfiles.d/firefox.conf",
		new TextEncoder().encode(
			"L  /opt/firefox-dev  -  -  -  -  /usr/lib/firefox-dev",
		),
	);
};

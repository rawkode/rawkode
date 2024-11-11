import { $ } from "zx";
import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "google-chrome",
		url: "https://dl.google.com/linux/chrome/rpm/stable/$basearch",
		keyUrl: "https://dl.google.com/linux/linux_signing_key.pub",
	});

	await installPackages([
		"google-chrome-beta",
	]);

	await $`mv /var/opt/google /usr/lib/google`;

	Deno.writeFileSync(
		"/usr/lib/tmpfiles.d/firefox.conf",
		new TextEncoder().encode(
			"L  /opt/google  -  -  -  -  /usr/lib/google",
		),
	);
};

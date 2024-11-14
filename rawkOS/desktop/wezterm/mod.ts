import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "wezterm",
		url: "https://download.copr.fedorainfracloud.org/results/wezfurlong/wezterm-nightly/fedora-$releasever-$basearch/",
		keyUrl: "https://download.copr.fedorainfracloud.org/results/wezfurlong/wezterm-nightly/pubkey.gpg",
	});

	await installPackages([
		"wezterm",
	]);
};

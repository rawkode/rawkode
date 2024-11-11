import { $ } from "zx";
import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
		await addRepository({
		name: "copr-monaspace",
		url:
			"https://download.copr.fedorainfracloud.org/results/aquacash5/nerd-fonts/fedora-$releasever-$basearch/",
		keyUrl:
			"https://download.copr.fedorainfracloud.org/results/aquacash5/nerd-fonts/pubkey.gpg",
		});

	await installPackages([
		"cascadia-code-nerd-fonts",
		"monaspace-nerd-fonts",
		"nerd-fonts-symbols-only",
		"share-tech-mono-nerd-fonts",
	]);

	// await $`git clone https://github.com/githubnext/monaspace /tmp/monaspace`;
	// await $`mkdir -p /usr/share/fonts/Monaspace/`;
	// await $`bash -c 'cp /tmp/monaspace/fonts/otf/* /usr/share/fonts/Monaspace/'`;
	// await $`bash -c 'cp /tmp/monaspace/fonts/variable/* /usr/share/fonts/Monaspace/'`;
	// await $`fc-cache --system-only --really-force /usr/share/fonts/Monaspace/`;
	// await $`rm -rf /tmp/monaspace`;
};

import { $ } from "zx";
import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "tailscale",
		url: "https://pkgs.tailscale.com/stable/fedora/$basearch",
		keyUrl: "https://pkgs.tailscale.com/stable/fedora/repo.gpg",
	});

	await installPackages(["tailscale"]);

	await $`systemctl enable tailscaled`;
};

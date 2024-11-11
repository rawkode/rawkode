import { $ } from "zx";
import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "Docker",
		url:
			"https://download.docker.com/linux/fedora/$releasever/$basearch/stable",
		keyUrl: "https://download.docker.com/linux/fedora/gpg",
	});

	await installPackages([
		"docker-ce",
		"docker-ce-cli",
		"containerd.io",
		"docker-buildx-plugin",
		"docker-compose-plugin",
	]);

	// Mostly using podman, but need this on-demand
	await $`systemctl disable docker.service`;
};

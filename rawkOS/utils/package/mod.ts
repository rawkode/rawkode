import { runCommand } from "../commands/mod.ts";

export const archInstall = (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);

	runCommand("paru", [
		"--sync",
		...packages,
		"--needed",
		"--noconfirm",
		"--skipreview",
		"--removemake",
		"--cleanafter",
	]);

	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const flatpakInstall = (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);

	runCommand("flatpak", [
		"install",
		"--assumeyes",
		"flathub",
		...packages,
	]);

	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const brewInstall = (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);

	runCommand("/home/linuxbrew/.linuxbrew/bin/brew", [
		"install",
		...packages,
	]);

	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

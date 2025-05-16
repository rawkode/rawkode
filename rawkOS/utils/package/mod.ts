import { runCommand } from "../commands/mod.ts";

export const archInstall = async (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);

	await runCommand("paru", [
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

export const flatpakInstall = async (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);

	await runCommand("flatpak", [
		"install",
		"--assumeyes",
		"flathub",
		...packages,
	]);

	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const brewInstall = async (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);

	await runCommand("/home/linuxbrew/.linuxbrew/bin/brew", [
		"install",
		...packages,
	]);

	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const goInstall = async (packageName: string) => {
	console.log(`Installing package: ${packageName}...`);

	await runCommand("go", ["install", packageName]);

	console.log(`Finished installing package: ${packageName}`);
};

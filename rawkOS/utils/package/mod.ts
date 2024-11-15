import { $ } from "zx";

export const archInstall = async (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);
	await $`paru --sync --refresh ${packages} --needed --noconfirm --skipreview --removemake --cleanafter`;
	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const brewInstall = async (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);
	await $`brew install ${packages}`;
	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

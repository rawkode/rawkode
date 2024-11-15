import { $, spinner } from "zx";

export const archInstall = async (packages: string[]) => {
	await spinner(`Installing packages: ${packages.join(", ")}...`, async () => {
		await $`paru --sync --refresh ${packages} --needed --noconfirm --skipreview --removemake --cleanafter`;
	});
};

export const brewInstall = async (packages: string[]) => {
	await spinner(`Installing packages: ${packages.join(", ")}...`, async () => {
		await $`brew install ${packages}`;
	});
};

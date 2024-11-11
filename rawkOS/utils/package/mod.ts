import { $ } from "zx";
import { stringify } from "@std/ini";

interface PackageRepository {
	name: string;
	url: string;
	keyUrl: string;
}

export const addRepository = async (repository: PackageRepository) => {
	console.log(`Adding repository ${repository.name}...`);

	const iniString = stringify({
		[repository.name]: {
			name: repository.name,
			baseurl: repository.url,
			enabled: 1,
			gpgcheck: 1,
			gpgkey: repository.keyUrl,
		},
	});

	Deno.writeFileSync(
		`/etc/yum.repos.d/${repository.name}.repo`,
		new TextEncoder().encode(iniString),
	);

	console.log(`Importing repository key from ${repository.keyUrl}...`);
	await $`rpm --import ${repository.keyUrl}`;
};

export const installPackages = async (packages: string[]) => {
	console.log(`Installing packages: ${packages.join(", ")}...`);
	await $`rpm-ostree install ${packages}`;
	console.log(`Finished installing packages: ${packages.join(", ")}`);
};

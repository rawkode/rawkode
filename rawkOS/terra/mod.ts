import { addRepository, installPackages } from "../utils/package/mod.ts";

export default async () => {
	const url = `https://repos.fyralabs.com/terra${Deno.env.get("FEDORA_VERSION")}/`;

	await addRepository({
		name: "terra-release",
		url,
		keyUrl: `${url}key.asc`,
	});
	await installPackages(["terra-release"]);
};

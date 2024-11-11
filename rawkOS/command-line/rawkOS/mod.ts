import { $ } from "zx";
import { installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await installPackages(["just"]);

	Deno.writeFileSync(
		"/usr/bin/rawkOS",
		Deno.readFileSync(`${import.meta.dirname}/rawkOS`),
	);
	$`chmod +x /usr/bin/rawkOS`;
};

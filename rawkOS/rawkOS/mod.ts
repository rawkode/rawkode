import { $ } from "zx";
import { archInstall } from "../utils/package/mod.ts";

export default async () => {
	await archInstall(["just"]);

	Deno.writeFileSync(
		"/usr/bin/rawkOS",
		Deno.readFileSync(`${import.meta.dirname}/rawkOS`),
	);
	$`chmod +x /usr/bin/rawkOS`;
};

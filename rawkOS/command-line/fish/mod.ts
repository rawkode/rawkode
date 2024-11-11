import { installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await installPackages(["fish"]);

	Deno.writeFileSync(
		"/etc/profile.d/0-auto-fish.sh",
		Deno.readFileSync(`${import.meta.dirname}/auto-fish.sh`),
	);
};

import { installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await installPackages(["nu"]);

	// Why do we set the default shell via a bash interactive script?
	// Unfortunately, nushell doesn't process anything under /etc/profile
	// and as such, if we set our logiin shell to nu; we'd need to find a way
	// to set XDG_DIRS for it to find Nix applications.
	// This is simple for interactive shells, but less so for the process that launches the desktop
	// (I think)
	// I should try sometime.
	// await Deno.writeFileSync(
	// 	"/etc/profile.d/nushell.sh",
	// 	Deno.readFileSync(`${import.meta.dirname}/nushell.sh`),
	// );
};

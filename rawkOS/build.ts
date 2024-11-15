import { question } from "zx";
import { exists } from "@std/fs";

// We're doing 1password first, so that
// if we any secrets or need it's SSH agent
// it will be available.
await import("./desktop/onepassword/mod.ts");

const home = Deno.env.get("HOME")!;

console.log("Checking for 1Password SSH agent...");
while (!(await exists(`${home}/.1password/agent.sock`))) {
	switch (
		await question(
			"Please enable the 1Password SSH agent. Press: \n\t'y' to continue\n\t'n' to quit\n\t'z' to continue without the agent\n",
		)
	) {
		case "n":
			Deno.exit();
			break;

		case "z":
			break;

		default:
			Deno.env.set("SSH_AUTH_SOCK", "~/.1password/agent.sock");
			break;
	}
}

await import("./command-line/github/mod.ts");
await import("./command-line/fish/mod.ts");
await import("./command-line/direnv/mod.ts");
await import("./command-line/runme/mod.ts");

await import("./desktop/ghostty/mod.ts");
await import("./desktop/visual-studio-code/mod.ts");
await import("./desktop/zed/mod.ts");

await import("./command-line/direnv/mod.ts");
await import("./command-line/git/mod.ts");

await import("./command-line/podman/mod.ts");
await import("./command-line/docker/mod.ts");

await import("./command-line/tailscale/mod.ts");

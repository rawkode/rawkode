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

// Let's ensure we have GitHub known_hosts
// configured early.
await import("./command-line/github/mod.ts");

// While we don't use homebrew an awful lot,
// it's a good idea to have it installed early.
await import("./command-line/homebrew/mod.ts");

// Essentials
await import("./desktop/firefox/mod.ts");
await import("./desktop/microsoft-edge/mod.ts");

// Everything else
await import("./command-line/atuin/mod.ts");
await import("./command-line/direnv/mod.ts");
await import("./command-line/docker/mod.ts");
await import("./command-line/fish/mod.ts");
await import("./command-line/git/mod.ts");
await import("./command-line/google-cloud/mod.ts");
await import("./command-line/jj/mod.ts");
await import("./command-line/kubernetes/mod.ts");
await import("./command-line/nix/mod.ts");
await import("./command-line/nushell/mod.ts");
await import("./command-line/podman/mod.ts");
await import("./command-line/ripgrep/mod.ts");
await import("./command-line/runme/mod.ts");
await import("./command-line/starship/mod.ts");
await import("./command-line/tailscale/mod.ts");
await import("./command-line/zellij/mod.ts");
await import("./command-line/zoxide/mod.ts");

await import("./development/deno/mod.ts");
await import("./development/go/mod.ts");
await import("./development/rust/mod.ts");

await import("./desktop/dconf-editor/mod.ts");
await import("./desktop/ghostty/mod.ts");
await import("./desktop/gnome/mod.ts");
await import("./desktop/onepassword/mod.ts");
await import("./desktop/slack/mod.ts");
await import("./desktop/spotify/mod.ts");
await import("./desktop/visual-studio-code/mod.ts");
await import("./desktop/wezterm/mod.ts");
await import("./desktop/zed/mod.ts");
await import("./desktop/zulip/mod.ts");

await import("./system/amd/mod.ts");
await import("./system/dns/mod.ts");
await import("./system/fprintd/mod.ts");

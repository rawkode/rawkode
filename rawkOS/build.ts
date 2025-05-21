import meow from "meow";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Setting the GOPATH because we use go install
// This is also configured in go.fish, but we
// don't know for-sure if that's in-action yet.
import.meta.env.GOPATH = path.join(os.homedir(), "Code");

const app = meow(
  `
  Usage
    $ rawkOS

  Options
    --bootstrap            Ensure dependencies are met to use rawkOS
    --system               Run any action that configures the system
    --dotfiles             Just run users dotfiles
    --help                 Displays this message
    --version              Displays the version number

  Examples
    $ rawkOS --bootstrap
    $ rawkOS --dotfiles
    $ rawkOS --system
`,
  {
    importMeta: import.meta,
    version: "0.0.1",
    flags: {
      bootstrap: {
        type: "boolean",
      },
      system: {
        type: "boolean",
      },
      dotfiles: {
        type: "boolean",
      },
      version: {
        type: "boolean",
      },
      help: {
        type: "boolean",
      },
    },
  },
);

if (app.flags.version) {
  app.showVersion();
  process.exit(0);
}

if (app.flags.bootstrap) {
  // We're doing 1password first, so that
  // if we any secrets or need it's SSH agent
  // it will be available.
  await import("./desktop/onepassword/mod.ts");
  process.exit(0);
}

if (app.flags.system) {
  await import("./system/amd/mod.ts");
  await import("./system/dns/mod.ts");
  await import("./system/fonts/mod.ts");
  process.exit(0);
}

if (app.flags.dotfiles) {
  // Let's ensure we have GitHub known_hosts
  // configured early.
  await import("./command-line/github/mod.ts");

  // // Essentials
  await import("./desktop/firefox/mod.ts");

  // // Other packages have Go as a dependency, notably runme
  await import("./development/go/mod.ts");

  // // Everything else
  await import("./command-line/atuin/mod.ts");
  await import("./command-line/direnv/mod.ts");
  await import("./command-line/docker/mod.ts");
  await import("./command-line/espanso/mod.ts");
  await import("./command-line/fish/mod.ts");
  await import("./command-line/git/mod.ts");
  await import("./command-line/google-cloud/mod.ts");
  await import("./command-line/jj/mod.ts");
  await import("./command-line/kubernetes/mod.ts");
  await import("./command-line/nushell/mod.ts");
  await import("./command-line/ripgrep/mod.ts");
  await import("./command-line/runme/mod.ts");
  await import("./command-line/starship/mod.ts");
  await import("./command-line/tailscale/mod.ts");
  await import("./command-line/zellij/mod.ts");
  await import("./command-line/zoxide/mod.ts");

  await import("./development/deno/mod.ts");
  await import("./development/python/mod.ts");
  await import("./development/rust/mod.ts");

  await import("./desktop/catppuccin/mod.ts");
  await import("./desktop/dconf-editor/mod.ts");
  await import("./desktop/ghostty/mod.ts");
  await import("./desktop/gitbutler/mod.ts");
  // await import("./desktop/gnome/mod.ts");
  await import("./desktop/niri/mod.ts");
  await import("./desktop/slack/mod.ts");
  await import("./desktop/spotify/mod.ts");
  await import("./desktop/visual-studio-code/mod.ts");
  await import("./desktop/wezterm/mod.ts");
  await import("./desktop/zed/mod.ts");
  await import("./desktop/zulip/mod.ts");
  process.exit(0);
}

app.showHelp();
process.exit(0);

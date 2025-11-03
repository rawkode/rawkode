import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "atuin",
  tags: ["shell", "history"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install atuin - shell history management
  install("atuin"),

  // Link atuin config
  linkFile({
    source: source("config.toml"),
    target: userConfig("atuin/config.toml"),
    force: true,
    description: "Link atuin configuration",
  }),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/atuin.fish"),
    force: true,
    description: "Link atuin fish shell integration",
  }),

  // Link nushell integration (if using nushell)
  linkFile({
    source: source("init.nu"),
    target: userConfig("nushell/scripts/atuin.nu"),
    force: true,
    description: "Link atuin nushell integration",
  }),
])

import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "carapace",
  tags: ["shell", "completions"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install carapace - multi-shell completion generator
  install("carapace"),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/carapace.fish"),
    force: true,
    description: "Link carapace fish shell integration",
  }),

  // Link nushell integration (if using nushell)
  linkFile({
    source: source("init.nu"),
    target: userConfig("nushell/scripts/carapace.nu"),
    force: true,
    description: "Link carapace nushell integration",
  }),
])

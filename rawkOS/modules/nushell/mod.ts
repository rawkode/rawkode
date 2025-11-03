import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "nushell",
  tags: ["shell"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install nushell - modern shell with structured data
  install("nushell", { brew: "nushell" }),

  // Link nushell main config
  linkFile({
    source: source("config.nu"),
    target: userConfig("nushell/config.nu"),
    force: true,
    description: "Link nushell main configuration",
  }),

  // Link nushell env config
  linkFile({
    source: source("env.nu"),
    target: userConfig("nushell/env.nu"),
    force: true,
    description: "Link nushell environment configuration",
  }),

  // Link auto-ls script
  linkFile({
    source: source("auto-ls.nu"),
    target: userConfig("nushell/scripts/auto-ls.nu"),
    force: true,
    description: "Link nushell auto-ls script",
  }),
])

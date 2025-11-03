import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "television",
  tags: ["search", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install television - blazing fast general purpose fuzzy finder
  install("television", { brew: "alexpasmantier/television/television" }),

  // Link television config
  linkFile({
    source: source("config.toml"),
    target: userConfig("television/config.toml"),
    force: true,
    description: "Link television configuration",
  }),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/television.fish"),
    force: true,
    description: "Link television fish shell integration",
  }),
])

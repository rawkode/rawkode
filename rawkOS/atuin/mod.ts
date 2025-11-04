import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "atuin",
  tags: ["shell", "history"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("atuin"),

  linkFile({
    source: source("config.toml"),
    target: userConfig("atuin/config.toml"),
    force: true,
    description: "Link atuin configuration",
  }),

  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/atuin.fish"),
    force: true,
    description: "Link atuin fish shell integration",
  }),
])

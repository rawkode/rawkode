import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "ripgrep",
  tags: ["search", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install ripgrep
  install("ripgrep"),

  // Link ripgrep config
  linkFile({
    source: source("ripgreprc"),
    target: userConfig("ripgrep/ripgreprc"),
    force: true,
    description: "Link ripgrep configuration",
  }),

  // Link shell integration to set RIPGREP_CONFIG_PATH
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/ripgrep.fish"),
    force: true,
    description: "Link ripgrep fish shell integration",
  }),
])

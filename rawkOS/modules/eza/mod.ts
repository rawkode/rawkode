import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "eza",
  tags: ["file-manager", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install eza (modern ls replacement)
  install("eza"),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/eza.fish"),
    force: true,
    description: "Link eza fish shell integration",
  }),
])

import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "fzf",
  tags: ["search", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install fzf - command-line fuzzy finder
  install("fzf"),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/fzf.fish"),
    force: true,
    description: "Link fzf fish shell integration",
  }),
])

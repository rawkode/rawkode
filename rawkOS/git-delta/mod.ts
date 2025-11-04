import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "git-delta",
  tags: ["vcs", "development"],
  dependsOn: [],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("git-delta", { brew: "git-delta" }),

  // Delta config
  linkFile({
    source: source("delta.gitconfig"),
    target: userConfig("git/config.d/delta"),
    force: true,
    description: "Link git-delta config",
  }),
])

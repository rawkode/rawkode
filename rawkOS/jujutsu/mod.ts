import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "jujutsu",
  tags: ["vcs", "development"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install jujutsu (jj) - version control system
  install("jujutsu", { brew: "jj" }),

  // Link jujutsu config
  linkFile({
    source: source("config.toml"),
    target: userConfig("jj/config.toml"),
    force: true,
    description: "Link jujutsu configuration",
  }),
])

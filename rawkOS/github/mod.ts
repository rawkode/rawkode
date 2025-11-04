import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "github",
  tags: ["git", "development"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install GitHub CLI
  install("gh"),

  // Note: gh-copilot extension needs to be installed separately:
  // gh extension install github/gh-copilot

  // Link GitHub CLI config
  linkFile({
    source: source("config.yml"),
    target: userConfig("gh/config.yml"),
    force: true,
    description: "Link GitHub CLI configuration",
  }),
])

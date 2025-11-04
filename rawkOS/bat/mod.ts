import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "bat",
  tags: ["file-viewer", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install bat and bat-extras
  // Note: bat-extras includes batdiff, batgrep, batman, batpipe, batwatch, prettybat
  install("bat"),

  // Note: bat-extras may need separate installation on some systems:
  // - macOS: brew install bat-extras
  // - Linux: Install from https://github.com/eth-p/bat-extras or package manager

  // Link bat config
  linkFile({
    source: source("config"),
    target: userConfig("bat/config"),
    force: true,
    description: "Link bat configuration",
  }),

  // Link shell aliases (for fish integration)
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/bat.fish"),
    force: true,
    description: "Link bat fish shell integration",
  }),
])

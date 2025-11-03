import { defineModule, install, linkFile, source, userPath, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "ghostty",
  tags: ["terminal", "gui"],
  dependsOn: [],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install ghostty (brew on macOS handles it, package manager on Linux)
  install("ghostty", { brew: "ghostty" }),

  // Link main config for Linux
  linkFile({
    source: source("ghostty.conf"),
    target: userConfig("ghostty/config"),
    force: true,
    description: "Link ghostty config (Linux)",
  }),

  // Link Linux-specific config
  linkFile({
    source: source("ghostty-linux.conf"),
    target: userConfig("ghostty/linux"),
    force: true,
    description: "Link ghostty Linux config",
  }),

  // Link main config for macOS (different path)
  linkFile({
    source: source("ghostty.conf"),
    target: userPath("Library/Application Support/com.mitchellh.ghostty/config"),
    force: true,
    description: "Link ghostty config (macOS)",
  }),
])

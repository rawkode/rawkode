import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "htop",
  tags: ["system-monitor", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install htop - interactive process viewer
  // Note: htop-vim provides vim-like keybindings but may not be available on all systems
  install("htop"),

  // Link htop config
  linkFile({
    source: source("htoprc"),
    target: userConfig("htop/htoprc"),
    force: true,
    description: "Link htop configuration",
  }),
])

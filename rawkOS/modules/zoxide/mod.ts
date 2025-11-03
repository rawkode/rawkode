import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "zoxide",
  tags: ["shell", "navigation"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install zoxide - smarter directory jumping
  install("zoxide"),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/zoxide.fish"),
    force: true,
    description: "Link zoxide fish shell integration",
  }),
])

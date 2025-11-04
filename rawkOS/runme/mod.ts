import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "runme",
  tags: ["development", "documentation"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install runme - markdown runner
  install("runme"),

  // Link fish shell integration (completions)
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/runme.fish"),
    force: true,
    description: "Link runme fish shell integration",
  }),
])

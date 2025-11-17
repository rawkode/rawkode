import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "cuenv",
  tags: ["development", "environment"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install cuenv CLI via its custom tap
  install("cuenv", { brew: "cuenv/cuenv/cuenv" }),

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/cuenv.fish"),
    force: true,
    description: "Link cuenv fish shell integration",
  }),
])

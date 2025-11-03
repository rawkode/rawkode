import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "tldr",
  tags: ["documentation", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install tldr - simplified man pages
  install("tldr"),
])

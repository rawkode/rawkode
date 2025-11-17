import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "moon",
  tags: ["build-tool", "monorepo"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("moon"),
])

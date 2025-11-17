import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "node",
  tags: ["language", "javascript", "runtime"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("node"),
])

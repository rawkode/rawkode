import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "beads",
  tags: ["development"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("bd", { brew: "steveyegge/beads/bd" }),
])

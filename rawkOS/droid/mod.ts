import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "droid",
  tags: ["terminal", "cli"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("droid", { brew: "droid" }),
])

import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "warp",
  tags: ["terminal"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("warp", { brew: "warp" }),
])

import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "descript",
  tags: ["audio", "video", "editor"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("descript", { brew: "descript" }),
])

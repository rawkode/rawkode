import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "font-monaspace",
  tags: ["font"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("font-monaspace", { brew: "font-monaspace" }),
])

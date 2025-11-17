import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "slack",
  tags: ["communication", "chat"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("slack", { brew: "slack" }),
])

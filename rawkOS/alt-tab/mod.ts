import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "alt-tab",
  tags: ["productivity", "window-management"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("alt-tab", { brew: "alt-tab" }),
])

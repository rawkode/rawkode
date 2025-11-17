import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "discord",
  tags: ["communication", "chat"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("discord", { brew: "discord" }),
])

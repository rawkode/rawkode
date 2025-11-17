import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "mimestream",
  tags: ["productivity", "email"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("mimestream", { brew: "mimestream" }),
])

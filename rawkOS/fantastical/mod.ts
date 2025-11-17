import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "fantastical",
  tags: ["productivity", "calendar"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("fantastical", { brew: "fantastical" }),
])

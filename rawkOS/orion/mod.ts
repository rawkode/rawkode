import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "orion",
  tags: ["browser"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("orion", { brew: "orion" }),
])

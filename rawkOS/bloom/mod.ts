import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "bloom",
  tags: ["tool"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("bloom", { brew: "bloom" }),
])

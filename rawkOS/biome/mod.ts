import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "biome",
  tags: ["linter", "formatter", "javascript"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("biome"),
])

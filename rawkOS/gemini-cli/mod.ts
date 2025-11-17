import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "gemini-cli",
  tags: ["ai", "cli"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("gemini-cli"),
])

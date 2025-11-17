import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "claude-code",
  tags: ["ai", "cli", "tool"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("claude-code", { brew: "claude-code" }),
])

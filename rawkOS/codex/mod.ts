import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "codex",
  tags: ["tool"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("codex", { brew: "codex" }),
])

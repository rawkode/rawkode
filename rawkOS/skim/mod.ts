import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "skim",
  tags: ["search", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install skim (sk) - fuzzy finder written in Rust
  install("skim"),
])

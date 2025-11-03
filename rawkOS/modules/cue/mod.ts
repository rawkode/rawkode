import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "cue",
  tags: ["development", "configuration"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install CUE - configuration language
  install("cue", { brew: "cue-lang/tap/cue" }),
])

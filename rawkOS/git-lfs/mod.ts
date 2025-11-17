import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "git-lfs",
  tags: ["git", "extension"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("git-lfs"),
])

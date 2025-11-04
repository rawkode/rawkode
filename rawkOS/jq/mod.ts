import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "jq",
  tags: ["json", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install jq - command-line JSON processor
  install("jq"),
])

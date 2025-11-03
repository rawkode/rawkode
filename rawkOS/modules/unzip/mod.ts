import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "unzip",
  tags: ["utilities", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install unzip - archive extraction utility
  install("unzip"),
])

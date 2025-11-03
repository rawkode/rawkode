import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "vim",
  tags: ["editor", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install vim - text editor
  install("vim"),
])

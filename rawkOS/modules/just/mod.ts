import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "just",
  tags: ["development", "task-runner"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install just - command runner and task automation tool
  install("just"),
])

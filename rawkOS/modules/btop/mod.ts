import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "btop",
  tags: ["system-monitor", "cli-tools"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install btop - resource monitor
  install("btop"),
])

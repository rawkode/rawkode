import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "dagger",
  tags: ["devops", "ci"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("dagger", { brew: "dagger/tap/dagger" }),
])

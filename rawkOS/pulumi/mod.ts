import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "pulumi",
  tags: ["iac", "cloud"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("pulumi"),
])

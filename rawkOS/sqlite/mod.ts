import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "sqlite",
  tags: ["database", "sql"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("sqlite"),
])

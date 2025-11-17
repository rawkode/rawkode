import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "uv",
  tags: ["python", "package-manager"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("uv"),
])

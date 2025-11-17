import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "chrome",
  tags: ["browser"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("google-chrome", { brew: "google-chrome" }),
])

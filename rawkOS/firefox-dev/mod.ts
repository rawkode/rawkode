import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "firefox-dev",
  tags: ["browser", "development"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("firefox-dev", { brew: "firefox@developer-edition" }),
])

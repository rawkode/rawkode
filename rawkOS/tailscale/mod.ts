import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "tailscale",
  tags: ["networking"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("1475387142", { manager: "mas" }),
])

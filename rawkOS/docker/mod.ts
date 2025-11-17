import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "docker",
  tags: ["container", "dev-tool"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("docker", { brew: "docker-desktop" }),
])

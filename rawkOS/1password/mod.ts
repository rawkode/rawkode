import { defineModule, install, shellIntegration } from "@rawkode/dhd"

export default defineModule({
  name: "1password",
  tags: ["security", "password-manager", "cli"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  // GUI app (macOS)
  install("1password", { brew: "1password" }),
  // CLI
  install("op", { brew: "1password-cli" }),
  // Shell init for op plugin
  ...shellIntegration({
    tool: "1password",
    fish: "init.fish",
    zsh: "init.zsh",
  }),
])

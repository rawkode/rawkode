import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "vscode",
  tags: ["editor", "ide"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("vscode", { brew: "visual-studio-code" }),
])

import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "chatgpt",
  tags: ["ai", "assistant"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("chatgpt", { brew: "chatgpt" }),
])

import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "lazyjournal",
  tags: ["system", "logging"],
  when: [{ platformIn: ["linux"] }], // Linux-only (systemd journald)
}).actions([
  // Install lazyjournal - TUI for journalctl
  install("lazyjournal"),
])

import { defineModule, install, linkFile, source, userConfig, http } from "@rawkode/dhd"

export default defineModule({
  name: "zellij",
  tags: ["terminal", "multiplexer"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install zellij - terminal multiplexer
  install("zellij"),

  // Link zellij config
  linkFile({
    source: source("config.kdl"),
    target: userConfig("zellij/config.kdl"),
    force: true,
    description: "Link zellij configuration",
  }),

  // Download zellij-forgot plugin
  // Note: Integrity check omitted - could be added by computing hex SHA256
  linkFile({
    source: http("https://github.com/karimould/zellij-forgot/releases/download/0.4.2/zellij_forgot.wasm"),
    target: userConfig("zellij/plugins/zellij_forgot.wasm"),
    force: true,
    description: "Download and link zellij-forgot plugin",
  }),
])

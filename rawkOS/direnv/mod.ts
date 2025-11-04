import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "direnv",
  tags: ["development", "environment"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install direnv - environment variable manager
  install("direnv"),

  // Note: nix-direnv is a NixOS-specific extension for direnv
  // For non-NixOS systems, direnv works standalone

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/direnv.fish"),
    force: true,
    description: "Link direnv fish shell integration",
  }),
])

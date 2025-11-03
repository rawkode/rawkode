import { defineModule, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "cuenv",
  tags: ["development", "environment"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Note: cuenv is typically installed from a Nix flake or built from source
  // Manual installation required: https://github.com/cuenv/cuenv

  // Link fish shell integration
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/cuenv.fish"),
    force: true,
    description: "Link cuenv fish shell integration",
  }),
])

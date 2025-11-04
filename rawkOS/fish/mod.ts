import { defineModule, install, linkFile, source, userPath, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "fish",
  tags: ["shell", "terminal"],
  dependsOn: [],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("fish"),

  // Auto-launch fish from bash
  linkFile({
    source: source("auto-fish.sh"),
    target: userPath(".bashrc"),
    force: true,
    description: "Link bashrc to auto-launch fish",
  }),

  // Main fish config
  linkFile({
    source: source("config.fish"),
    target: userConfig("fish/config.fish"),
    force: true,
    description: "Link fish main config",
  }),

  // Fish functions
  linkFile({
    source: source("magic-enter.fish"),
    target: userConfig("fish/functions/magic-enter.fish"),
    force: true,
    description: "Link magic-enter function",
  }),

  linkFile({
    source: source("magic-enter-command.fish"),
    target: userConfig("fish/functions/magic-enter-command.fish"),
    force: true,
    description: "Link magic-enter-command function",
  }),

  // Git abbreviations - place in conf.d for auto-sourcing
  linkFile({
    source: source("git-abbr.fish"),
    target: userConfig("fish/conf.d/git-abbr.fish"),
    force: true,
    description: "Link git abbreviations",
  }),

  // Nix environment integration - place in conf.d for auto-sourcing
  linkFile({
    source: source("nix-env-init.fish"),
    target: userConfig("fish/conf.d/nix-env.fish"),
    force: true,
    description: "Link Nix environment integration",
  }),
])

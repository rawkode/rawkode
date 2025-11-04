import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd"

export default defineModule({
  name: "starship",
  tags: ["terminal"],
  dependsOn: [],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("starship"),
  linkFile({
    source: source("starship.toml"),
    target: userConfig("starship.toml"),
    force: true,
    description: "Link starship config",
  }),
  linkFile({
    source: source("starship.fish"),
    target: userConfig("fish/conf.d/starship.fish"),
    force: true,
    description: "Link starship fish integration",
  }),
  linkFile({
    source: source("starship.nu"),
    target: userConfig("nushell/conf.d/starship.nu"),
    force: true,
    description: "Link starship nushell integration",
  }),
])

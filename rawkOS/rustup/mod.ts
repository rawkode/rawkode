import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd";

export default defineModule({
  name: "rustup",
  tags: ["rust", "toolchain"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install(["rustup"]),

  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/rustup.fish"),
    force: true,
    description: "Link rustup fish shell integration",
  }),
]);

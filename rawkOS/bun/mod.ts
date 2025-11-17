import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd";

export default defineModule({
  name: "bun",
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install("bun"),
  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/bun.fish"),
    force: true,
    description: "Link Bun fish shell integration",
  }),
]);

import { defineModule, install, linkFile, source, userConfig } from "@rawkode/dhd";

export default defineModule({
  name: "go",
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  install(["go"]),

  linkFile({
    source: source("init.fish"),
    target: userConfig("fish/conf.d/go.fish"),
    force: true,
    description: "Link Go fish shell integration",
  }),
]);

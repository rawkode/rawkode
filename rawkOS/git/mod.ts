import { defineModule, install, linkFile, source, userPath, userConfig } from "@rawkode/dhd"

const actions: any[] = [
  install(["git", "git-lfs"]),

  linkFile({
    source: source("gitconfig"),
    target: userPath(".gitconfig"),
    force: true,
    description: "Link main git config",
  }),

  linkFile({
    source: source("gitignore"),
    target: userConfig("git/ignore"),
    force: true,
    description: "Link global gitignore",
  }),

  linkFile({
    source: source("git-commit-template.txt"),
    target: userConfig("git/templates/commit.txt"),
    force: true,
    description: "Link git commit template",
  }),
]

export default defineModule({
  name: "git",
  tags: ["vcs", "development"],
  dependsOn: ["git-delta"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions(actions)

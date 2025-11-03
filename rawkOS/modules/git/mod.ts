import { defineModule, install, linkFile, source, userPath, userConfig } from "@rawkode/dhd"

const actions: any[] = [
  install(["git", "git-lfs"]),

  // Main git config
  linkFile({
    source: source("gitconfig"),
    target: userPath(".gitconfig"),
    force: true,
    description: "Link main git config",
  }),

  // Global gitignore
  linkFile({
    source: source("gitignore_global"),
    target: userConfig("git/ignore"),
    force: true,
    description: "Link global gitignore",
  }),

  // Commit template
  linkFile({
    source: source("git-commit-template.txt"),
    target: userConfig("git/templates/commit.txt"),
    force: true,
    description: "Link git commit template",
  }),
]

// Add Linux-specific config override
if (process.platform === "linux") {
  actions.push(
    linkFile({
      source: source("gitconfig-linux"),
      target: userConfig("git/config.d/linux"),
      force: true,
      description: "Link Linux-specific git config",
    })
  )
}

export default defineModule({
  name: "git",
  tags: ["vcs", "development"],
  dependsOn: ["git-delta"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions(actions)

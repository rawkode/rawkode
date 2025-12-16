package git

import "github.com/rawkode/rawkcue/schema"

git: schema.#Module & {
	name:      "git"
	tags:      ["vcs", "development"]
	dependsOn: ["git-delta"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "git"}, {default: "git-lfs"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "gitconfig"}
			target:      {kind: "User", path: ".gitconfig"}
			force:       true
			description: "Link main git config"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "gitignore"}
			target:      {kind: "User", path: ".config/git/ignore"}
			force:       true
			description: "Link global gitignore"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "git-commit-template.txt"}
			target:      {kind: "User", path: ".config/git/templates/commit.txt"}
			force:       true
			description: "Link git commit template"
		},
	]
}

package gitdelta

import "github.com/rawkode/rawkcue/schema"

"git-delta": schema.#Module & {
	name: "git-delta"
	tags: ["vcs", "development"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "git-delta", brew: "git-delta"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "delta.gitconfig"}
			target:      {kind: "User", path: ".config/git/config.d/delta"}
			force:       true
			description: "Link git-delta config"
		},
	]
}

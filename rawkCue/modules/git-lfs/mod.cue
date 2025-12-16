package gitlfs

import "github.com/rawkode/rawkcue/schema"

"git-lfs": schema.#Module & {
	name: "git-lfs"
	tags: ["git", "extension"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "git-lfs"}]
		},
	]
}

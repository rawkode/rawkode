package codex

import "github.com/rawkode/rawkcue/schema"

codex: schema.#Module & {
	name: "codex"
	tags: ["tool"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "codex", brew: "codex"}]
		},
	]
}

package cue

import "github.com/rawkode/rawkcue/schema"

cue: schema.#Module & {
	name: "cue"
	tags: ["development", "configuration"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "cue", brew: "cue-lang/tap/cue"}]
		},
	]
}

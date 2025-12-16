package droid

import "github.com/rawkode/rawkcue/schema"

droid: schema.#Module & {
	name: "droid"
	tags: ["terminal", "cli"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "droid", brew: "droid"}]
		},
	]
}

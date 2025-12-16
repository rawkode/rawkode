package just

import "github.com/rawkode/rawkcue/schema"

just: schema.#Module & {
	name: "just"
	tags: ["development", "task-runner"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "just"}]
		},
	]
}

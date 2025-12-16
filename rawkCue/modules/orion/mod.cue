package orion

import "github.com/rawkode/rawkcue/schema"

orion: schema.#Module & {
	name: "orion"
	tags: ["browser"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "orion", brew: "orion"}]
		},
	]
}

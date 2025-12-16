package biome

import "github.com/rawkode/rawkcue/schema"

biome: schema.#Module & {
	name: "biome"
	tags: ["linter", "formatter", "javascript"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "biome"}]
		},
	]
}

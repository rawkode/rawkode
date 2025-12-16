package moon

import "github.com/rawkode/rawkcue/schema"

moon: schema.#Module & {
	name: "moon"
	tags: ["build-tool", "monorepo"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "moon"}]
		},
	]
}

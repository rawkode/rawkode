package sqlite

import "github.com/rawkode/rawkcue/schema"

sqlite: schema.#Module & {
	name: "sqlite"
	tags: ["database", "sql"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "sqlite"}]
		},
	]
}

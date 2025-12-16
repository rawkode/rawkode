package node

import "github.com/rawkode/rawkcue/schema"

node: schema.#Module & {
	name: "node"
	tags: ["language", "javascript", "runtime"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "node"}]
		},
	]
}

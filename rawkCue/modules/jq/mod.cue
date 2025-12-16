package jq

import "github.com/rawkode/rawkcue/schema"

jq: schema.#Module & {
	name: "jq"
	tags: ["json", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "jq"}]
		},
	]
}

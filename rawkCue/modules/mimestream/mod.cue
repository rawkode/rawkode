package mimestream

import "github.com/rawkode/rawkcue/schema"

mimestream: schema.#Module & {
	name: "mimestream"
	tags: ["productivity", "email"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "mimestream", brew: "mimestream"}]
		},
	]
}

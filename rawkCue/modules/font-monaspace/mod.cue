package fontmonaspace

import "github.com/rawkode/rawkcue/schema"

"font-monaspace": schema.#Module & {
	name: "font-monaspace"
	tags: ["font"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "font-monaspace", brew: "font-monaspace"}]
		},
	]
}

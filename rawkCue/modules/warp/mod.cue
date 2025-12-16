package warp

import "github.com/rawkode/rawkcue/schema"

warp: schema.#Module & {
	name: "warp"
	tags: ["terminal"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "warp", brew: "warp"}]
		},
	]
}

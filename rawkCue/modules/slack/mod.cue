package slack

import "github.com/rawkode/rawkcue/schema"

slack: schema.#Module & {
	name: "slack"
	tags: ["communication", "chat"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "slack", brew: "slack"}]
		},
	]
}

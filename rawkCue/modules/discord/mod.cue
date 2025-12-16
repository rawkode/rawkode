package discord

import "github.com/rawkode/rawkcue/schema"

discord: schema.#Module & {
	name: "discord"
	tags: ["communication", "chat"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "discord", brew: "discord"}]
		},
	]
}

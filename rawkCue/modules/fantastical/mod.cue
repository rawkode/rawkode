package fantastical

import "github.com/rawkode/rawkcue/schema"

fantastical: schema.#Module & {
	name: "fantastical"
	tags: ["productivity", "calendar"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "fantastical", brew: "fantastical"}]
		},
	]
}

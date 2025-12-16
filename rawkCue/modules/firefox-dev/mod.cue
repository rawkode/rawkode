package firefoxdev

import "github.com/rawkode/rawkcue/schema"

"firefox-dev": schema.#Module & {
	name: "firefox-dev"
	tags: ["browser", "development"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "firefox-dev", brew: "firefox@developer-edition"}]
		},
	]
}

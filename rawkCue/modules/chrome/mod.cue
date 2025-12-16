package chrome

import "github.com/rawkode/rawkcue/schema"

chrome: schema.#Module & {
	name: "chrome"
	tags: ["browser"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "google-chrome", brew: "google-chrome"}]
		},
	]
}

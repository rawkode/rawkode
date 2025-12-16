package googlecloud

import "github.com/rawkode/rawkcue/schema"

"google-cloud": schema.#Module & {
	name: "google-cloud"
	tags: ["cloud", "development"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "google-cloud-sdk", brew: "google-cloud-sdk"}]
		},
	]
}

package dagger

import "github.com/rawkode/rawkcue/schema"

dagger: schema.#Module & {
	name: "dagger"
	tags: ["devops", "ci"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "dagger", brew: "dagger/tap/dagger"}]
		},
	]
}

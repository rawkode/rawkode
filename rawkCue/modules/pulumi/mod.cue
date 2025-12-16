package pulumi

import "github.com/rawkode/rawkcue/schema"

pulumi: schema.#Module & {
	name: "pulumi"
	tags: ["iac", "cloud"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "pulumi"}]
		},
	]
}

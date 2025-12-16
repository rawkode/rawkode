package skim

import "github.com/rawkode/rawkcue/schema"

skim: schema.#Module & {
	name: "skim"
	tags: ["search", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "skim"}]
		},
	]
}

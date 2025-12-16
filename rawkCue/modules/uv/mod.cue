package uv

import "github.com/rawkode/rawkcue/schema"

uv: schema.#Module & {
	name: "uv"
	tags: ["python", "package-manager"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "uv"}]
		},
	]
}

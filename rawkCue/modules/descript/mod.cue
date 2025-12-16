package descript

import "github.com/rawkode/rawkcue/schema"

descript: schema.#Module & {
	name: "descript"
	tags: ["audio", "video", "editor"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "descript", brew: "descript"}]
		},
	]
}

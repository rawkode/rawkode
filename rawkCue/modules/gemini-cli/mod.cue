package geminicli

import "github.com/rawkode/rawkcue/schema"

"gemini-cli": schema.#Module & {
	name: "gemini-cli"
	tags: ["ai", "cli"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "gemini-cli"}]
		},
	]
}

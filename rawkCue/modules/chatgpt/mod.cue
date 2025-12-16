package chatgpt

import "github.com/rawkode/rawkcue/schema"

chatgpt: schema.#Module & {
	name: "chatgpt"
	tags: ["ai", "assistant"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "chatgpt", brew: "chatgpt"}]
		},
	]
}

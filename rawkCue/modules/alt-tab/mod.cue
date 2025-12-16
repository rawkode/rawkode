package alttab

import "github.com/rawkode/rawkcue/schema"

"alt-tab": schema.#Module & {
	name: "alt-tab"
	tags: ["productivity", "window-management"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "alt-tab", brew: "alt-tab"}]
		},
	]
}

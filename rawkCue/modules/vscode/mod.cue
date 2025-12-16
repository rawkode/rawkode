package vscode

import "github.com/rawkode/rawkcue/schema"

vscode: schema.#Module & {
	name: "vscode"
	tags: ["editor", "ide"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "vscode", brew: "visual-studio-code"}]
		},
	]
}

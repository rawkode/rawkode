package docker

import "github.com/rawkode/rawkcue/schema"

docker: schema.#Module & {
	name: "docker"
	tags: ["container", "dev-tool"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "docker", brew: "docker-desktop"}]
		},
	]
}

package bloom

import "github.com/rawkode/rawkcue/schema"

bloom: schema.#Module & {
	name: "bloom"
	tags: ["ai", "gui"]
	when: [{platformIn: ["darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "bloom", brew: "homebrew/cask/bloom"}]
		},
		schema.#RunCommand & {
			type:    "runCommand"
			command: "defaults write -g NSFileViewer -string com.asiafu.Bloom"
		},
		schema.#RunCommand & {
			type:    "runCommand"
			command: "defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | grep -q \"com.asiafu.Bloom\" || defaults write com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers -array-add '{LSHandlerContentType=\"public.folder\";LSHandlerRoleAll=\"com.asiafu.Bloom\";}'"
		},
	]
}

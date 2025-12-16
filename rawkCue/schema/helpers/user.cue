package helpers

import "github.com/rawkode/rawkcue/schema"

// User configuration helper - sets the default shell
// This generates platform-specific commands that the executor will filter

#UserOptions: {
	shell: string | *"fish"
}

// Usage: (helpers.#User & {opts: {shell: "fish"}}).out
#User: {
	opts: #UserOptions

	out: schema.#Module & {
		name:      "user"
		tags:      ["user", "shell"]
		dependsOn: [opts.shell]
		actions: [
			// Add shell to /etc/shells if not present (cross-platform)
			schema.#RunCommand & {
				type:        "runCommand"
				command:     "SHELL_PATH=$(which \(opts.shell)); grep -qxF \"$SHELL_PATH\" /etc/shells || echo \"$SHELL_PATH\" | tee -a /etc/shells"
				sudo:        true
				description: "Add \(opts.shell) to /etc/shells if not present"
			},
			// macOS: use Directory Services
			schema.#RunCommand & {
				type:        "runCommand"
				command:     "dscl . -create /Users/$USER UserShell $(which \(opts.shell))"
				sudo:        true
				description: "Set \(opts.shell) as default shell via Directory Services (macOS)"
			},
			// Linux: use chsh
			schema.#RunCommand & {
				type:        "runCommand"
				command:     "chsh -s $(which \(opts.shell))"
				description: "Set \(opts.shell) as default shell (Linux)"
			},
		]
	}
}

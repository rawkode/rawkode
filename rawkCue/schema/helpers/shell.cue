package helpers

import "github.com/rawkode/rawkcue/schema"

// Shell integration helper - generates linkFile actions for shell init scripts
// Follows the convention of placing scripts in shell-specific conf.d directories

#ShellIntegrationOptions: {
	// Tool name (used in target filename)
	tool: string & !=""

	// Relative paths to shell init scripts in the module directory
	fish?:    string
	nushell?: string
	bash?:    string
	zsh?:     string
}

// Usage: (helpers.#ShellIntegration & {opts: {tool: "zoxide", fish: "init.fish"}}).out
#ShellIntegration: {
	opts: #ShellIntegrationOptions

	out: [
		if opts.fish != _|_ {
			schema.#LinkFile & {
				type:        "linkFile"
				source:      schema.#Source & {kind: "Source", relativePath: opts.fish}
				target:      schema.#UserPath & {kind: "User", path: ".config/fish/conf.d/\(opts.tool).fish"}
				force:       true
				description: "Link \(opts.tool) Fish shell integration"
			}
		},
		if opts.nushell != _|_ {
			schema.#LinkFile & {
				type:        "linkFile"
				source:      schema.#Source & {kind: "Source", relativePath: opts.nushell}
				target:      schema.#UserPath & {kind: "User", path: ".config/nushell/conf.d/\(opts.tool).nu"}
				force:       true
				description: "Link \(opts.tool) Nushell integration"
			}
		},
		if opts.bash != _|_ {
			schema.#LinkFile & {
				type:        "linkFile"
				source:      schema.#Source & {kind: "Source", relativePath: opts.bash}
				target:      schema.#UserPath & {kind: "User", path: ".bashrc.d/\(opts.tool).sh"}
				force:       true
				description: "Link \(opts.tool) Bash integration"
			}
		},
		if opts.zsh != _|_ {
			schema.#LinkFile & {
				type:        "linkFile"
				source:      schema.#Source & {kind: "Source", relativePath: opts.zsh}
				target:      schema.#UserPath & {kind: "User", path: ".zshrc.d/\(opts.tool).zsh"}
				force:       true
				description: "Link \(opts.tool) Zsh integration"
			}
		},
	]
}

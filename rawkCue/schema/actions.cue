package schema

// Package manager identifiers
#PackageManager: "brew" | "pacman" | "apt" | "dnf" | "yay" | "nix" | "mas"

// Package specification with optional per-manager overrides
#Package: {
	default:  string & !=""
	brew?:    string
	pacman?:  string
	apt?:     string
	dnf?:     string
	yay?:     string
	nix?:     string
	mas?:     string
	manager?: #PackageManager // Force specific manager
}

// #Install - install packages via package managers
#Install: {
	type:     "install"
	packages: [...#Package] & [_, ...] // At least one package required
}

// #LinkFile - create symlinks from source to target
#LinkFile: {
	type:         "linkFile"
	source:       #FileRef
	target:       #TargetRef
	force:        bool | *false
	description?: string
}

// #RunCommand - execute shell commands
#RunCommand: {
	type:         "runCommand"
	command:      string & !=""
	sudo:         bool | *false
	description?: string
}

// Value types for macOS defaults
#DefaultsValueType: "string" | "bool" | "int" | "float" | "array" | "array-add" | "dict" | "dict-add" | "data"

// #Defaults - macOS defaults write operations
#Defaults: {
	type:       "defaults"
	domain:     string & !=""
	key:        string & !=""
	value:      bool | number | string | [...] | {[string]: _}
	valueType?: #DefaultsValueType
	host?:      "currentHost"
	description?: string
}

// Launchd actions
#LaunchdAction: "load" | "unload" | "enable" | "disable"

// Launchd domains
#LaunchdDomain: "user" | "system" | "gui"

// #Launchd - manage launchd services on macOS
#Launchd: {
	type:   "launchd"
	action: #LaunchdAction

	// Exactly one of plistPath or serviceName required
	plistPath?:   string
	serviceName?: string

	domain:      #LaunchdDomain | *"user"
	description?: string
}

// Login item actions
#LoginItemAction: "add" | "remove"

// #LoginItem - manage macOS login items
#LoginItem: {
	type:         "loginItem"
	action:       #LoginItemAction
	app:          string & !=""
	hidden:       bool | *false
	description?: string
}

// Union of all action types
#Action: #Install | #LinkFile | #RunCommand | #Defaults | #Launchd | #LoginItem

// Convenience constructors for cleaner module authoring

// install: single package shorthand
// Usage: install["starship"]
install: [P=string]: #Install & {packages: [{default: P}]}

// installWith: package with overrides
// Usage: installWith["docker"] & {brew: "docker-desktop"}
installWith: [P=string]: #Install & {packages: [{default: P, ...}]}

// defaults: macOS defaults shorthand
// Usage: defaults & {domain: "com.apple.dock", key: "autohide", value: true}
defaults: #Defaults & {type: "defaults"}

// runCommand: command shorthand
// Usage: runCommand & {command: "echo hello"}
runCommand: #RunCommand & {type: "runCommand"}

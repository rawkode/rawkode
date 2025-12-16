package schema

// Platform identifiers
#Platform: "linux" | "darwin" | "win32"

// Architecture identifiers
#Arch: "x64" | "arm64"

// Declarative when condition for platform/architecture gating
#WhenCondition: {
	platformIn?: [...#Platform]
	archIn?:     [...#Arch]
}

// #Module - the main module definition
// Modules declare what packages to install, files to link, and commands to run
#Module: {
	// Module name (kebab-case identifier, may start with digit for names like "1password")
	name: string & =~"^[a-z0-9][a-z0-9-]*$"

	// Categorization tags for filtering
	tags: [...string] | *[]

	// Dependencies on other modules (execution order)
	dependsOn: [...string] | *[]

	// Conditional execution based on platform/architecture
	when?: [...#WhenCondition]

	// Actions to perform
	actions: [...#Action]

	// Internal: module path set during discovery (used for source path resolution)
	_modulePath?: string
}

// module: convenience constructor with name inference
// Usage: module.starship & {tags: [...], actions: [...]}
module: [N=string]: #Module & {name: N}

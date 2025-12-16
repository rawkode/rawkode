package schema

// #Source references a file relative to the module directory
// Path resolution happens during execution, not CUE evaluation
#Source: {
	kind:         "Source"
	relativePath: string & !=""
}

// #UserPath references a file under $HOME
#UserPath: {
	kind: "User"
	path: string & !=""
}

// #SystemPath references an absolute system path
#SystemPath: {
	kind: "System"
	path: string & =~"^/"
}

// #Http references a remote file to download with optional integrity check
#Http: {
	kind:       "Http"
	url:        string & =~"^https?://"
	integrity?: string & =~"^sha256-[0-9a-fA-F]{64}$"
}

// Union of all file reference types
#FileRef: #Source | #UserPath | #SystemPath | #Http

// Union of valid target types (symlink destinations)
#TargetRef: #UserPath | #SystemPath

// Shorthand constructors for ergonomic module authoring
// Usage: source["config.toml"] or source.config_toml (if valid identifier)
source: [P=string]: #Source & {relativePath: P}

// Usage: userPath[".bashrc"]
userPath: [P=string]: #UserPath & {path: P}

// Usage: userConfig["starship.toml"] -> ~/.config/starship.toml
userConfig: [P=string]: #UserPath & {path: ".config/\(P)"}

// Usage: systemPath["/etc/shells"]
systemPath: [P=string]: #SystemPath & {path: P}

// Usage: http["https://example.com/file"]
http: [U=string]: #Http & {url: U}

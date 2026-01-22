package rawko

config: {
	acp: default: {
		command: "gemini"
		args: ["--experimental-acp"]
	}

	observability: terminal: {
		enabled:             true
		verbosity:           "default"
		colors:              true
		progress_indicators: true
	}

	state: {
		retention_days: 7
		max_tasks:      100
	}
}

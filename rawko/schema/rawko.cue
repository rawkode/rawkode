// rawko Configuration Schema
// This file defines the configuration structure for rawko
package rawko

// Root structure
config: #Config
agents: [string]: #Agent

// #Config is the root configuration type
#Config: {
	// acp configures default ACP settings
	acp?: #AcpConfig

	// observability configures logging and telemetry
	observability: #ObservabilityConfig

	// state configures task persistence and retention
	state: #StateConfig
}

// #AcpConfig configures ACP defaults
#AcpConfig: {
	// default provides default command/args for all agents
	default?: #AcpDefaults
}

// #AcpDefaults defines default values applied to all agents
#AcpDefaults: {
	// command is the default ACP agent executable
	command: string

	// args are default arguments passed to the command
	args?: [...string]
}

// #ObservabilityConfig configures logging and telemetry
#ObservabilityConfig: {
	// terminal configures terminal output settings
	terminal: #TerminalConfig

	// otel configures OpenTelemetry settings
	otel?: #OtelConfig
}

// #TerminalConfig configures terminal output
#TerminalConfig: {
	// enabled controls whether terminal output is active
	enabled: bool | *true

	// verbosity controls the output level (quiet, default, verbose, debug)
	verbosity: #Verbosity | *"default"

	// colors enables/disables colored output
	colors: bool | *true

	// progress_indicators enables/disables progress spinners and bars
	progress_indicators: bool | *true
}

// #Verbosity enumerates the verbosity levels
#Verbosity: "quiet" | "default" | "verbose" | "debug"

// #OtelConfig configures OpenTelemetry
#OtelConfig: {
	// enabled controls whether OpenTelemetry is active
	enabled: bool | *false

	// endpoint is the OTLP endpoint URL
	endpoint?: string

	// service_name is the service name for traces
	service_name: string | *"rawko"

	// sample_rate is the trace sampling rate (0.0-1.0)
	sample_rate: float | *1.0
}

// #StateConfig configures task state persistence
#StateConfig: {
	// retention_days is how long to keep completed task state
	retention_days: int | *30

	// max_tasks is the maximum number of tasks to keep in state
	max_tasks: int | *1000

	// persist_path is the directory for state files (optional, uses ~/.local/share/rawko if not set)
	persist_path?: string
}

// #Agent defines an agent configuration
#Agent: {
	// name is an optional display name (defaults to the agent key)
	name?: string

	// whenToUse is a semantic description for arbiter selection (when should this agent be used)
	whenToUse: string

	// prompt defines the agent's behavior (system prompt)
	prompt: string & !=""

	// command is the ACP agent executable (e.g., "claude", "gemini", "aider")
	command?: string

	// args are arguments passed to the command (e.g., ["--acp"])
	args?: [...string]
}

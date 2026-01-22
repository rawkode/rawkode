use thiserror::Error;

/// Main error type for rawko
#[derive(Error, Debug)]
pub enum Error {
    // Configuration errors
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Configuration file not found: {path}")]
    ConfigNotFound { path: String },

    #[error("Invalid configuration: {message}")]
    ConfigInvalid { message: String },

    // Agent errors
    #[error("Agent error: {message}")]
    Agent { message: String },

    #[error("Agent error: {agent} - {message}")]
    AgentWithContext { agent: String, message: String },

    #[error("Agent not found: {0}")]
    AgentNotFound(String),

    #[error("Agent definition invalid: {agent} - {message}")]
    AgentDefinitionInvalid { agent: String, message: String },

    // Tool errors
    #[error("Tool error: {tool} - {message}")]
    Tool { tool: String, message: String },

    #[error("Tool not found: {0}")]
    ToolNotFound(String),

    #[error("Tool access denied: {agent} cannot access {tool}")]
    ToolAccessDenied { agent: String, tool: String },

    // Protocol errors
    #[error("Protocol error: {message}")]
    Protocol { message: String },

    #[error("Invalid message format: {0}")]
    MessageFormat(String),

    #[error("Transport error: {0}")]
    Transport(String),

    // State errors
    #[error("State persistence error: {0}")]
    State(String),

    #[error("Task not found: {0}")]
    TaskNotFound(String),

    // IO errors
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    // JSON errors
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Result type alias for rawko
pub type Result<T> = std::result::Result<T, Error>;

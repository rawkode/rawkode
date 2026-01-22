//! Configuration module for rawko
//!
//! This module handles loading, merging, and validating configuration
//! from CUE files using the cuengine crate.

use crate::{Error, Result};
use serde::{Deserialize, Deserializer};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Deserializes a Vec, treating null as empty vec
/// This is needed because cuengine converts empty CUE arrays to JSON null
fn deserialize_null_as_empty_vec<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let opt: Option<Vec<T>> = Option::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

/// Root configuration type that maps to the CUE root structure
#[derive(Debug, Clone, Deserialize)]
pub struct RawkoConfig {
    /// Config settings (observability, state, acp)
    pub config: Config,

    /// Agent definitions
    #[serde(default)]
    pub agents: HashMap<String, AgentDef>,
}

/// Config settings (nested under `config:` in CUE)
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// ACP configuration
    pub acp: Option<AcpConfig>,

    /// Observability settings
    #[serde(default)]
    pub observability: ObservabilityConfig,

    /// State persistence settings
    #[serde(default)]
    pub state: StateConfig,
}

/// ACP configuration
#[derive(Debug, Clone, Deserialize)]
pub struct AcpConfig {
    /// Default command/args for all agents
    pub default: Option<AcpDefaults>,
}

/// Default command and args applied to all agents
#[derive(Debug, Clone, Deserialize)]
pub struct AcpDefaults {
    /// Default ACP agent executable
    pub command: String,

    /// Default arguments passed to the command
    #[serde(default, deserialize_with = "deserialize_null_as_empty_vec")]
    pub args: Vec<String>,
}

/// Observability configuration
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ObservabilityConfig {
    /// Terminal output settings
    #[serde(default)]
    pub terminal: TerminalConfig,

    /// OpenTelemetry settings
    pub otel: Option<OtelConfig>,
}

/// Terminal output configuration
#[derive(Debug, Clone, Deserialize)]
pub struct TerminalConfig {
    /// Whether terminal output is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Verbosity level
    #[serde(default)]
    pub verbosity: Verbosity,

    /// Whether to use colors
    #[serde(default = "default_true")]
    pub colors: bool,

    /// Whether to show progress indicators
    #[serde(default = "default_true")]
    pub progress_indicators: bool,
}

fn default_true() -> bool {
    true
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            verbosity: Verbosity::Default,
            colors: true,
            progress_indicators: true,
        }
    }
}

/// Verbosity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Verbosity {
    Quiet,
    #[default]
    Default,
    Verbose,
    Debug,
}

/// OpenTelemetry configuration
#[derive(Debug, Clone, Deserialize)]
pub struct OtelConfig {
    /// Whether OpenTelemetry is enabled
    #[serde(default)]
    pub enabled: bool,

    /// OTLP endpoint URL
    pub endpoint: Option<String>,

    /// Service name for traces
    #[serde(default = "default_service_name")]
    pub service_name: String,

    /// Trace sampling rate (0.0-1.0)
    #[serde(default = "default_sample_rate")]
    pub sample_rate: f64,
}

fn default_service_name() -> String {
    "rawko".to_string()
}

fn default_sample_rate() -> f64 {
    1.0
}

/// State persistence configuration
#[derive(Debug, Clone, Deserialize)]
pub struct StateConfig {
    /// How long to keep completed task state (days)
    #[serde(default = "default_retention_days")]
    pub retention_days: i32,

    /// Maximum number of tasks to keep in state
    #[serde(default = "default_max_tasks")]
    pub max_tasks: i32,

    /// Directory for state files
    pub persist_path: Option<String>,
}

fn default_retention_days() -> i32 {
    30
}

fn default_max_tasks() -> i32 {
    1000
}

impl Default for StateConfig {
    fn default() -> Self {
        Self {
            retention_days: default_retention_days(),
            max_tasks: default_max_tasks(),
            persist_path: None,
        }
    }
}

/// Agent definition matching the CUE #Agent schema
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    /// Optional display name for this agent (defaults to the map key)
    pub name: Option<String>,

    /// Semantic description for arbiter selection (when should this agent be used)
    pub when_to_use: String,

    /// System prompt defining agent behavior
    pub prompt: String,

    /// ACP launch command (e.g., "claude", "gemini", "aider")
    pub command: Option<String>,

    /// Arguments to pass to the command (e.g., ["--acp"])
    #[serde(default, deserialize_with = "deserialize_null_as_empty_vec")]
    pub args: Vec<String>,
}

impl AgentDef {
    /// Returns the display name for this agent.
    /// If a custom name is set, returns that; otherwise returns the provided key.
    pub fn display_name<'a>(&'a self, key: &'a str) -> &'a str {
        self.name.as_deref().unwrap_or(key)
    }
}

/// Finds the global and project config directories/files
///
/// Returns (global_config_dir, project_config_dir)
/// Global config is a directory at ~/.config/rawko/
/// Project config is a directory at .rawko/ (preferred) or a single file rawko.cue
fn find_config_locations() -> (Option<PathBuf>, Option<PathBuf>) {
    // Global config directory: ~/.config/rawko/
    let global_config = dirs::config_dir().map(|p| p.join("rawko"));
    let global_exists = global_config
        .as_ref()
        .map(|p| p.join("config.cue").exists())
        .unwrap_or(false);

    // Project config: check .rawko/ directory first, then rawko.cue file
    let project_config = if PathBuf::from(".rawko").is_dir() {
        Some(PathBuf::from(".rawko"))
    } else if PathBuf::from("rawko.cue").exists() {
        Some(PathBuf::from("rawko.cue"))
    } else {
        None
    };

    (
        if global_exists { global_config } else { None },
        project_config,
    )
}

/// Substitutes environment variables in a string
///
/// Replaces ${VAR} with the value of environment variable VAR
fn substitute_env_in_string(s: &str) -> Result<String> {
    let mut result = s.to_string();
    let mut start_idx = 0;

    while let Some(start) = result[start_idx..].find("${") {
        let abs_start = start_idx + start;
        if let Some(end) = result[abs_start..].find('}') {
            let abs_end = abs_start + end;
            let var_name = &result[abs_start + 2..abs_end];
            let var_value = std::env::var(var_name).map_err(|_| {
                Error::Config(format!("Environment variable '{}' not found", var_name))
            })?;
            result.replace_range(abs_start..abs_end + 1, &var_value);
            start_idx = abs_start + var_value.len();
        } else {
            // No closing brace, skip this occurrence
            start_idx = abs_start + 2;
        }
    }

    Ok(result)
}

/// Substitutes environment variables in all string fields of the config
fn substitute_env_vars(config: &mut RawkoConfig) -> Result<()> {
    // Substitute in otel endpoint
    if let Some(ref mut otel) = config.config.observability.otel {
        if let Some(ref endpoint) = otel.endpoint {
            otel.endpoint = Some(substitute_env_in_string(endpoint)?);
        }
    }

    // Substitute in state persist_path
    if let Some(ref persist_path) = config.config.state.persist_path {
        config.config.state.persist_path = Some(substitute_env_in_string(persist_path)?);
    }

    Ok(())
}

/// Validates the configuration
fn validate_config(config: &RawkoConfig) -> Result<()> {
    // Validate agent definitions
    validate_agents(config)?;

    Ok(())
}

/// Validates agent definitions
fn validate_agents(config: &RawkoConfig) -> Result<()> {
    for (key, agent) in &config.agents {
        // Validate when_to_use is not empty (except for arbiter which doesn't need it)
        if key != "arbiter" && agent.when_to_use.trim().is_empty() {
            return Err(Error::ConfigInvalid {
                message: format!("Agent '{}' must have a non-empty when_to_use", key),
            });
        }

        // Validate prompt is not empty
        if agent.prompt.trim().is_empty() {
            return Err(Error::ConfigInvalid {
                message: format!("Agent '{}' must have a non-empty prompt", key),
            });
        }
    }

    Ok(())
}

/// Loads configuration from CUE files
///
/// This function:
/// 1. Finds global config at `~/.config/rawko/`
/// 2. Finds project config at `.rawko/` or `rawko.cue`
/// 3. Merges configs using CUE unification
/// 4. Deserializes into Rust structs
/// 5. Substitutes environment variables
/// 6. Validates the final config
pub fn load_config() -> Result<RawkoConfig> {
    let (global_config, project_config) = find_config_locations();

    // If no config exists, return an error
    if global_config.is_none() && project_config.is_none() {
        return Err(Error::ConfigNotFound {
            path: "~/.config/rawko/ or .rawko/".to_string(),
        });
    }

    // Create a temp directory for merging configs
    let temp_dir = tempfile::tempdir().map_err(|e| Error::Config(format!("Failed to create temp directory: {}", e)))?;
    let temp_path = temp_dir.path();

    // Create cue.mod directory with module.cue (required by cuengine)
    let cue_mod_dir = temp_path.join("cue.mod");
    std::fs::create_dir_all(&cue_mod_dir)
        .map_err(|e| Error::Config(format!("Failed to create cue.mod directory: {}", e)))?;
    std::fs::write(
        cue_mod_dir.join("module.cue"),
        "module: \"rawko.dev/config\"\nlanguage: version: \"v0.9.0\"\n",
    )
    .map_err(|e| Error::Config(format!("Failed to write module.cue: {}", e)))?;

    // Note: We don't copy the schema files because they only contain type definitions (#Config, #Agent, etc.)
    // which would interfere with the concrete config values. The schema is for documentation/validation
    // during CUE development, not for runtime merging.

    // Copy global config files
    if let Some(ref global_dir) = global_config {
        copy_cue_files_with_prefix(global_dir, temp_path, "global_")?;
    }

    // Copy project config (directory or single file)
    if let Some(ref project_path) = project_config {
        if project_path.is_dir() {
            copy_cue_files_with_prefix(project_path, temp_path, "project_")?;
        } else {
            // Single file (rawko.cue)
            let content = std::fs::read_to_string(project_path).map_err(|e| {
                Error::Config(format!("Failed to read project config: {}", e))
            })?;
            let content = ensure_package_name(&content, "rawko");
            std::fs::write(temp_path.join("project_config.cue"), content)
                .map_err(|e| Error::Config(format!("Failed to write project config: {}", e)))?;
        }
    }

    // Evaluate CUE and deserialize into RawkoConfig
    let mut config: RawkoConfig = cuengine::evaluate_cue_package_typed(temp_path, "rawko")
        .map_err(|e| Error::ConfigInvalid {
            message: format!("CUE evaluation failed: {}", e),
        })?;

    // Substitute environment variables
    substitute_env_vars(&mut config)?;

    // Validate the config
    validate_config(&config)?;

    Ok(config)
}

/// Copies CUE files from source to destination with a filename prefix
/// Also ensures the package name is correct
fn copy_cue_files_with_prefix(src: &Path, dst: &Path, prefix: &str) -> Result<()> {
    for entry in std::fs::read_dir(src).map_err(|e| Error::Config(format!("Failed to read dir: {}", e)))? {
        let entry = entry.map_err(|e| Error::Config(format!("Failed to read entry: {}", e)))?;
        let path = entry.path();
        if path.extension().map(|e| e == "cue").unwrap_or(false) {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| Error::Config(format!("Failed to read CUE file: {}", e)))?;
            let content = ensure_package_name(&content, "rawko");
            let filename = path.file_name().unwrap().to_string_lossy();
            let dst_file = dst.join(format!("{}{}", prefix, filename));
            std::fs::write(&dst_file, content)
                .map_err(|e| Error::Config(format!("Failed to write CUE file: {}", e)))?;
        }
    }
    Ok(())
}

/// Ensures the CUE content has the correct package name
fn ensure_package_name(content: &str, package_name: &str) -> String {
    // Check if content already has a package declaration
    if content.trim_start().starts_with("package ") {
        // Replace the existing package name
        let lines: Vec<&str> = content.lines().collect();
        let mut result = Vec::new();
        let mut found_package = false;
        for line in lines {
            if line.trim_start().starts_with("package ") && !found_package {
                result.push(format!("package {}", package_name));
                found_package = true;
            } else {
                result.push(line.to_string());
            }
        }
        result.join("\n")
    } else {
        // Add package declaration at the beginning
        format!("package {}\n\n{}", package_name, content)
    }
}

/// Loads configuration from a specific path (for testing)
pub fn load_config_from_path(path: &Path) -> Result<RawkoConfig> {
    let mut config: RawkoConfig = cuengine::evaluate_cue_package_typed(path, "rawko")
        .map_err(|e| Error::ConfigInvalid {
            message: format!("CUE evaluation failed: {}", e),
        })?;

    substitute_env_vars(&mut config)?;
    validate_config(&config)?;

    Ok(config)
}

/// Returns the default configuration
pub fn default_config() -> RawkoConfig {
    RawkoConfig {
        config: Config {
            acp: None,
            observability: ObservabilityConfig::default(),
            state: StateConfig::default(),
        },
        agents: HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_substitute_env_in_string() {
        // Set up test environment variable
        std::env::set_var("TEST_VAR", "test_value");

        let result = substitute_env_in_string("Hello ${TEST_VAR}!").unwrap();
        assert_eq!(result, "Hello test_value!");

        let result = substitute_env_in_string("No vars here").unwrap();
        assert_eq!(result, "No vars here");

        let result = substitute_env_in_string("${TEST_VAR} at start").unwrap();
        assert_eq!(result, "test_value at start");

        let result = substitute_env_in_string("Multiple ${TEST_VAR} and ${TEST_VAR}").unwrap();
        assert_eq!(result, "Multiple test_value and test_value");

        // Clean up
        std::env::remove_var("TEST_VAR");
    }

    #[test]
    fn test_substitute_env_missing_var() {
        let result = substitute_env_in_string("${NONEXISTENT_VAR_12345}");
        assert!(result.is_err());
    }

    #[test]
    fn test_ensure_package_name_existing() {
        let content = "package foo\n\nsome: \"content\"";
        let result = ensure_package_name(content, "rawko");
        assert!(result.starts_with("package rawko"));
        assert!(result.contains("some: \"content\""));
    }

    #[test]
    fn test_ensure_package_name_missing() {
        let content = "some: \"content\"";
        let result = ensure_package_name(content, "rawko");
        assert!(result.starts_with("package rawko"));
        assert!(result.contains("some: \"content\""));
    }

    #[test]
    fn test_default_config() {
        let config = default_config();
        assert!(config.config.observability.terminal.enabled);
        assert_eq!(config.config.state.retention_days, 30);
    }

    #[test]
    fn test_validate_config_valid() {
        let config = default_config();
        let result = validate_config(&config);
        assert!(result.is_ok());
    }
}

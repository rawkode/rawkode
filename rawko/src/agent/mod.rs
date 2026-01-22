//! Agent module for rawko
//!
//! This module provides the agent registry and agent management functionality.
//! Agent definitions are loaded from the unified CUE configuration.

mod builtin;

use crate::config::{AcpDefaults, AgentDef, RawkoConfig};
use crate::Result;
use std::collections::HashMap;

pub use builtin::BUILTIN_AGENTS_CUE;

/// Registry holding all loaded agents
#[derive(Debug, Clone)]
pub struct AgentRegistry {
    agents: HashMap<String, AgentDef>,
}

impl AgentRegistry {
    /// Creates an empty agent registry
    pub fn new() -> Self {
        Self {
            agents: HashMap::new(),
        }
    }

    /// Creates an agent registry from a config
    ///
    /// This loads agents from the config and validates them.
    pub fn from_config(config: &RawkoConfig) -> Result<Self> {
        let mut registry = Self::new();

        // Add agents from config
        for (name, agent) in &config.agents {
            registry.agents.insert(name.clone(), agent.clone());
        }

        Ok(registry)
    }

    /// Creates an agent registry with built-in agents merged with config agents
    ///
    /// Built-in agents are overridden by config agents with the same name.
    /// Agent defaults (command/args) are applied to all agents that don't have them set.
    pub fn with_builtins(config: &RawkoConfig) -> Result<Self> {
        let mut registry = Self::new();

        // First, load built-in agents
        let builtin_agents = builtin::load_builtin_agents()?;
        for (name, agent) in builtin_agents {
            registry.agents.insert(name, agent);
        }

        // Then, merge config agents (config overrides built-in)
        for (name, agent) in &config.agents {
            registry.agents.insert(name.clone(), agent.clone());
        }

        // Apply agent defaults to all agents that don't have command set
        if let Some(ref acp_config) = config.config.acp {
            if let Some(ref defaults) = acp_config.default {
                registry.apply_defaults(defaults);
            }
        }

        Ok(registry)
    }

    /// Applies default command/args to all agents that don't have them set
    fn apply_defaults(&mut self, defaults: &AcpDefaults) {
        for agent in self.agents.values_mut() {
            if agent.command.is_none() {
                agent.command = Some(defaults.command.clone());
                // Only apply default args if agent has no command (and thus no args)
                if agent.args.is_empty() {
                    agent.args = defaults.args.clone();
                }
            }
        }
    }

    /// Gets an agent by name
    pub fn get(&self, name: &str) -> Option<&AgentDef> {
        self.agents.get(name)
    }

    /// Checks if an agent exists
    pub fn contains(&self, name: &str) -> bool {
        self.agents.contains_key(name)
    }

    /// Returns all agent names
    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.agents.keys()
    }

    /// Returns all agents
    pub fn agents(&self) -> impl Iterator<Item = (&String, &AgentDef)> {
        self.agents.iter()
    }

    /// Returns the number of agents
    pub fn len(&self) -> usize {
        self.agents.len()
    }

    /// Checks if the registry is empty
    pub fn is_empty(&self) -> bool {
        self.agents.is_empty()
    }

    /// Gets agent selection context for the arbiter
    ///
    /// Returns a formatted string with all agent keys, display names, and their when_to_use descriptions.
    /// Format: "- key (display_name): when_to_use" or "- key: when_to_use" if display name matches key.
    /// Excludes the arbiter itself since it's not selected by the arbiter.
    pub fn agent_selection_context(&self, exclude_arbiter: &str) -> String {
        let mut descriptions = Vec::new();
        for (key, agent) in &self.agents {
            // Skip the arbiter itself
            if key == exclude_arbiter {
                continue;
            }
            let display_name = agent.display_name(key);
            if display_name == key {
                descriptions.push(format!("- {}: {}", key, agent.when_to_use));
            } else {
                descriptions.push(format!("- {} ({}): {}", key, display_name, agent.when_to_use));
            }
        }
        descriptions.sort();
        descriptions.join("\n")
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{default_config, AgentDef};

    fn create_test_agent(_key: &str, when_to_use: &str) -> AgentDef {
        AgentDef {
            name: None, // Display name will default to the key
            when_to_use: when_to_use.to_string(),
            prompt: "Test prompt".to_string(),
            command: None,
            args: vec![],
        }
    }

    #[test]
    fn test_empty_registry() {
        let registry = AgentRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_registry_from_config() {
        let mut config = default_config();
        config.agents.insert(
            "test".to_string(),
            create_test_agent("test", "Use when testing"),
        );

        let registry = AgentRegistry::from_config(&config).unwrap();
        assert_eq!(registry.len(), 1);
        assert!(registry.contains("test"));
    }

    #[test]
    fn test_get_agent() {
        let mut config = default_config();
        config.agents.insert(
            "developer".to_string(),
            create_test_agent("developer", "Use when code needs to be written"),
        );

        let registry = AgentRegistry::from_config(&config).unwrap();
        let agent = registry.get("developer").unwrap();
        assert_eq!(agent.display_name("developer"), "developer");
        assert_eq!(agent.when_to_use, "Use when code needs to be written");
    }

    #[test]
    fn test_agent_selection_context() {
        let mut config = default_config();
        config.agents.insert(
            "developer".to_string(),
            create_test_agent("developer", "Use when code needs to be written"),
        );
        config.agents.insert(
            "reviewer".to_string(),
            create_test_agent("reviewer", "Use after code changes to review"),
        );
        config.agents.insert(
            "arbiter".to_string(),
            create_test_agent("arbiter", ""),
        );

        let registry = AgentRegistry::from_config(&config).unwrap();
        let context = registry.agent_selection_context("arbiter");
        assert!(context.contains("developer: Use when code needs to be written"));
        assert!(context.contains("reviewer: Use after code changes to review"));
        assert!(!context.contains("arbiter"));
    }
}

//! Agent pool for managing multiple agent connections.

use std::collections::HashMap;
use std::path::PathBuf;

use tokio::sync::mpsc;

use super::connection::AgentConnection;
use super::AgentOutput;
use crate::config::AgentDef;
use crate::{Error, Result};

/// Manages a pool of agent connections.
///
/// Agents are spawned lazily when first requested and kept alive
/// for subsequent prompts.
pub struct AgentPool {
    /// Active agent connections by agent name.
    connections: HashMap<String, AgentConnection>,
    /// Agent definitions from config.
    agents: HashMap<String, AgentDef>,
    /// Working directory for agents.
    cwd: PathBuf,
    /// Channel for agent output.
    output_tx: mpsc::UnboundedSender<AgentOutput>,
}

impl AgentPool {
    /// Creates a new agent pool.
    pub fn new(
        agents: HashMap<String, AgentDef>,
        cwd: PathBuf,
        output_tx: mpsc::UnboundedSender<AgentOutput>,
    ) -> Self {
        Self {
            connections: HashMap::new(),
            agents,
            cwd,
            output_tx,
        }
    }

    /// Gets or spawns an agent connection.
    ///
    /// If the agent is already running, returns the existing connection.
    /// Otherwise, spawns a new agent process.
    pub async fn get_or_spawn(&mut self, agent_name: &str) -> Result<&mut AgentConnection> {
        if !self.connections.contains_key(agent_name) {
            let agent_def = self.agents.get(agent_name).ok_or_else(|| Error::Agent {
                message: format!("Unknown agent: {}", agent_name),
            })?;

            let command = agent_def.command.as_ref().ok_or_else(|| Error::Agent {
                message: format!("Agent '{}' has no command configured", agent_name),
            })?;

            let conn = AgentConnection::spawn(
                command,
                &agent_def.args,
                &std::collections::HashMap::new(),
                self.cwd.clone(),
                self.output_tx.clone(),
            )
            .await?;

            // Initialize the connection
            conn.initialize().await?;

            self.connections.insert(agent_name.to_string(), conn);
        }

        Ok(self.connections.get_mut(agent_name).unwrap())
    }

    /// Shuts down all active agent connections gracefully.
    ///
    /// This cancels any running prompts and shuts down each agent connection
    /// before clearing the pool.
    pub async fn shutdown_all(&mut self) {
        let connections: Vec<(String, AgentConnection)> = self.connections.drain().collect();

        for (name, conn) in connections {
            tracing::debug!("Shutting down agent: {}", name);
            if let Err(e) = conn.shutdown().await {
                tracing::warn!("Error shutting down agent {}: {}", name, e);
            }
        }
    }

    /// Returns the names of currently active agents.
    pub fn active_agents(&self) -> Vec<&str> {
        self.connections.keys().map(|s| s.as_str()).collect()
    }
}

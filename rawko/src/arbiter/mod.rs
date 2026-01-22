//! Arbiter module for agent orchestration decisions.
//!
//! The arbiter is responsible for deciding which agent should handle the next
//! step of a task. It's implemented as an ACP agent itself, using the same
//! infrastructure as task agents.

use std::path::PathBuf;

use tokio::sync::mpsc;

use crate::acp::{AgentConnection, AgentOutput};
use crate::agent::AgentRegistry;
use crate::config::AgentDef;
use crate::fsm::TaskContext;
use crate::{Error, Result};

/// Decision made by the arbiter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArbiterDecision {
    /// Select a specific agent to handle the next step.
    SelectAgent {
        /// Name of the agent to invoke.
        agent_name: String,
        /// Reasoning for the selection.
        reasoning: String,
    },
    /// The task is complete, no more agents needed.
    Complete {
        /// Reasoning for why the task is complete.
        reasoning: String,
    },
    /// The last agent should retry with a different approach.
    Retry {
        /// Reasoning for the retry.
        reasoning: String,
    },
}

/// Configuration for the arbiter.
#[derive(Debug, Clone)]
pub struct ArbiterConfig {
    /// Name of the agent to use as arbiter (default: "arbiter").
    pub agent_name: String,
    /// Maximum number of iterations before forcing completion.
    pub max_iterations: u32,
}

impl Default for ArbiterConfig {
    fn default() -> Self {
        Self {
            agent_name: "arbiter".to_string(),
            max_iterations: 50,
        }
    }
}

/// The arbiter that makes agent selection decisions.
///
/// The arbiter uses an ACP agent to analyze task context and decide
/// which agent should handle the next step.
pub struct Arbiter {
    /// Configuration for the arbiter.
    config: ArbiterConfig,
    /// The arbiter's dedicated agent connection.
    connection: Option<AgentConnection>,
    /// Output sender for the arbiter's responses.
    output_tx: mpsc::UnboundedSender<AgentOutput>,
    /// Output receiver for collecting responses.
    output_rx: Option<mpsc::UnboundedReceiver<AgentOutput>>,
}

impl Arbiter {
    /// Creates a new arbiter with the given configuration.
    pub fn new(config: ArbiterConfig) -> Self {
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        Self {
            config,
            connection: None,
            output_tx,
            output_rx: Some(output_rx),
        }
    }

    /// Creates a new arbiter with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(ArbiterConfig::default())
    }

    /// Gets the initial agent selection for a new task.
    ///
    /// This is called when a new task is received and we need to decide
    /// which agent should handle it first.
    pub async fn select_initial_agent(
        &mut self,
        registry: &AgentRegistry,
        task_request: &str,
        cwd: PathBuf,
    ) -> Result<ArbiterDecision> {
        // Create a minimal context for initial selection
        let prompt = self.format_initial_prompt(registry, task_request);

        self.query_arbiter(registry, &prompt, cwd).await
    }

    /// Gets the next agent selection after a previous execution.
    ///
    /// This is called after an agent completes to decide if we need
    /// another agent or if the task is complete.
    pub async fn select_next_agent(
        &mut self,
        registry: &AgentRegistry,
        context: &TaskContext,
        cwd: PathBuf,
    ) -> Result<ArbiterDecision> {
        // Check if we've hit max iterations
        if context.agent_history.len() as u32 >= self.config.max_iterations {
            return Ok(ArbiterDecision::Complete {
                reasoning: format!(
                    "Maximum iterations ({}) reached",
                    self.config.max_iterations
                ),
            });
        }

        let prompt = self.format_context_prompt(registry, context);

        let decision = self.query_arbiter(registry, &prompt, cwd.clone()).await?;

        // Validate the decision
        self.validate_decision(&decision, registry, context)?;

        Ok(decision)
    }

    /// Shuts down the arbiter's agent connection.
    pub async fn shutdown(&mut self) -> Result<()> {
        if let Some(conn) = self.connection.take() {
            conn.shutdown().await?;
        }
        Ok(())
    }

    /// Formats the prompt for initial agent selection (no history).
    fn format_initial_prompt(&self, registry: &AgentRegistry, task_request: &str) -> String {
        // Filter out arbiter from available agents
        let available_agents = self.format_available_agents(registry);

        format!(
            r#"## Current Task
{task_request}

## Available Agents
{available_agents}

## Execution History
No previous executions - this is a new task.

## Constraints
- Iterations: 0/{max_iter}
- This is the initial agent selection

## Instructions
Analyze the task and select the most appropriate agent to start working on it.
Respond with: SELECT: agent_name | your reasoning"#,
            task_request = task_request,
            available_agents = available_agents,
            max_iter = self.config.max_iterations,
        )
    }

    /// Formats the full context prompt for the arbiter.
    fn format_context_prompt(&self, registry: &AgentRegistry, context: &TaskContext) -> String {
        let available_agents = self.format_available_agents(registry);
        let history = self.format_history(context);
        let constraints = self.format_constraints(context);

        format!(
            r#"## Current Task
{request}

## Available Agents
{available_agents}

## Execution History
{history}

## Constraints
{constraints}

## Instructions
Analyze the task and history, then respond with exactly ONE of:
- SELECT: agent_name | your reasoning
- COMPLETE | your reasoning (if task is done)
- RETRY | your reasoning (if last agent failed and should retry differently)"#,
            request = context.request,
            available_agents = available_agents,
            history = history,
            constraints = constraints,
        )
    }

    /// Formats the available agents section, excluding the arbiter.
    fn format_available_agents(&self, registry: &AgentRegistry) -> String {
        registry.agent_selection_context(&self.config.agent_name)
    }

    /// Formats the execution history for the prompt.
    fn format_history(&self, context: &TaskContext) -> String {
        if context.agent_history.is_empty() {
            return "No previous executions.".to_string();
        }

        let mut history = Vec::new();
        for (i, invocation) in context.agent_history.iter().enumerate() {
            let status = match invocation.result.status {
                crate::types::AgentResultStatus::Success => "SUCCESS",
                crate::types::AgentResultStatus::Failure => "FAILURE",
                crate::types::AgentResultStatus::NeedsRetry => "NEEDS_RETRY",
            };

            // Truncate output if too long
            let output = if invocation.result.output.len() > 500 {
                format!("{}...[truncated]", &invocation.result.output[..500])
            } else {
                invocation.result.output.clone()
            };

            let tool_count = invocation.result.tool_calls.len();

            // Show both key and display name if they differ
            let agent_display = if invocation.agent_name == invocation.display_name {
                invocation.agent_name.clone()
            } else {
                format!("{} ({})", invocation.agent_name, invocation.display_name)
            };

            history.push(format!(
                "### Step {} - Agent: {} ({})
Output: {}
Tool calls: {}",
                i + 1,
                agent_display,
                status,
                output,
                tool_count
            ));
        }

        history.join("\n\n")
    }

    /// Formats the constraints section for the prompt.
    fn format_constraints(&self, context: &TaskContext) -> String {
        let mut constraints = vec![format!(
            "- Iterations: {}/{}",
            context.agent_history.len(),
            self.config.max_iterations
        )];

        constraints.push(format!(
            "- Failures: {}/{}",
            context.failure_count, context.max_failures
        ));

        constraints.join("\n")
    }

    /// Queries the arbiter agent and parses the response.
    async fn query_arbiter(
        &mut self,
        registry: &AgentRegistry,
        prompt: &str,
        cwd: PathBuf,
    ) -> Result<ArbiterDecision> {
        // Get the arbiter agent definition
        let agent_def = registry.get(&self.config.agent_name).ok_or_else(|| Error::Agent {
            message: format!("Arbiter agent '{}' not found in registry", self.config.agent_name),
        })?;

        // Ensure connection is established and create session
        self.ensure_connection_and_session(agent_def, cwd).await?;

        // Send the prompt - this waits for the prompt to complete
        if let Some(ref conn) = self.connection {
            conn.prompt(prompt).await?;
        } else {
            return Err(Error::Agent {
                message: "Connection not established".to_string(),
            });
        }

        // Collect response from the output channel
        let response = self.collect_response().await?;

        // Parse the response
        parse_arbiter_response(&response)
    }

    /// Ensures the arbiter agent connection is established and session is created.
    async fn ensure_connection_and_session(
        &mut self,
        agent_def: &AgentDef,
        cwd: PathBuf,
    ) -> Result<()> {
        if self.connection.is_none() {
            let command = agent_def.command.as_ref().ok_or_else(|| Error::Agent {
                message: format!(
                    "Arbiter agent '{}' has no command configured",
                    self.config.agent_name
                ),
            })?;

            let conn = AgentConnection::spawn(
                command,
                &agent_def.args,
                &std::collections::HashMap::new(),
                cwd.clone(),
                self.output_tx.clone(),
            )
            .await?;

            conn.initialize().await?;

            self.connection = Some(conn);
        }

        // Create session if needed
        if let Some(ref mut conn) = self.connection {
            if conn.session_id().is_none() {
                conn.new_session(cwd).await?;
            }
        }

        Ok(())
    }

    /// Collects the response from the output channel.
    async fn collect_response(&mut self) -> Result<String> {
        let mut response = String::new();

        // Take the receiver temporarily
        let mut rx = self.output_rx.take().ok_or_else(|| Error::Agent {
            message: "Arbiter output receiver not available".to_string(),
        })?;

        // Collect all available output
        // The prompt() call should have completed, so all output should be available
        while let Ok(output) = rx.try_recv() {
            match output {
                AgentOutput::Text(text) => {
                    response.push_str(&text);
                }
                AgentOutput::Other(_) => {
                    // Ignore non-text output
                }
            }
        }

        // Put the receiver back
        self.output_rx = Some(rx);

        if response.is_empty() {
            return Err(Error::Agent {
                message: "No response received from arbiter agent".to_string(),
            });
        }

        Ok(response)
    }

    /// Validates the arbiter's decision against constraints.
    fn validate_decision(
        &self,
        decision: &ArbiterDecision,
        registry: &AgentRegistry,
        context: &TaskContext,
    ) -> Result<()> {
        match decision {
            ArbiterDecision::SelectAgent { agent_name, .. } => {
                // Check agent exists
                if !registry.contains(agent_name) {
                    return Err(Error::Agent {
                        message: format!("Arbiter selected unknown agent: {}", agent_name),
                    });
                }
                Ok(())
            }
            ArbiterDecision::Complete { .. } => Ok(()),
            ArbiterDecision::Retry { .. } => {
                // Retry is only valid if there was a previous execution
                if context.agent_history.is_empty() {
                    return Err(Error::Agent {
                        message: "Cannot retry: no previous execution".to_string(),
                    });
                }
                Ok(())
            }
        }
    }
}

/// Parses an arbiter response into a decision.
///
/// Expected formats:
/// - "SELECT: agent_name | reasoning"
/// - "COMPLETE | reasoning"
/// - "RETRY | reasoning"
pub fn parse_arbiter_response(response: &str) -> Result<ArbiterDecision> {
    let response = response.trim();

    // Try to parse SELECT
    if let Some(rest) = response.strip_prefix("SELECT:") {
        let rest = rest.trim();
        if let Some((agent_name, reasoning)) = rest.split_once('|') {
            return Ok(ArbiterDecision::SelectAgent {
                agent_name: agent_name.trim().to_string(),
                reasoning: reasoning.trim().to_string(),
            });
        } else {
            // No reasoning provided, use the rest as agent name
            return Ok(ArbiterDecision::SelectAgent {
                agent_name: rest.to_string(),
                reasoning: String::new(),
            });
        }
    }

    // Try to parse COMPLETE
    if let Some(rest) = response.strip_prefix("COMPLETE") {
        let rest = rest.trim();
        let reasoning = if let Some(r) = rest.strip_prefix('|') {
            r.trim().to_string()
        } else {
            rest.to_string()
        };
        return Ok(ArbiterDecision::Complete { reasoning });
    }

    // Try to parse RETRY
    if let Some(rest) = response.strip_prefix("RETRY") {
        let rest = rest.trim();
        let reasoning = if let Some(r) = rest.strip_prefix('|') {
            r.trim().to_string()
        } else {
            rest.to_string()
        };
        return Ok(ArbiterDecision::Retry { reasoning });
    }

    Err(Error::Agent {
        message: format!(
            "Failed to parse arbiter response. Expected SELECT:/COMPLETE/RETRY, got: {}",
            if response.len() > 100 {
                format!("{}...", &response[..100])
            } else {
                response.to_string()
            }
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_config;
    use crate::types::{AgentResult, AgentResultStatus, TaskId};

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
    fn test_parse_select_with_reasoning() {
        let response = "SELECT: developer | The task requires writing code";
        let decision = parse_arbiter_response(response).unwrap();

        match decision {
            ArbiterDecision::SelectAgent {
                agent_name,
                reasoning,
            } => {
                assert_eq!(agent_name, "developer");
                assert_eq!(reasoning, "The task requires writing code");
            }
            _ => panic!("Expected SelectAgent"),
        }
    }

    #[test]
    fn test_parse_select_without_reasoning() {
        let response = "SELECT: planner";
        let decision = parse_arbiter_response(response).unwrap();

        match decision {
            ArbiterDecision::SelectAgent {
                agent_name,
                reasoning,
            } => {
                assert_eq!(agent_name, "planner");
                assert!(reasoning.is_empty());
            }
            _ => panic!("Expected SelectAgent"),
        }
    }

    #[test]
    fn test_parse_complete_with_reasoning() {
        let response = "COMPLETE | The task has been fully implemented and tested";
        let decision = parse_arbiter_response(response).unwrap();

        match decision {
            ArbiterDecision::Complete { reasoning } => {
                assert_eq!(reasoning, "The task has been fully implemented and tested");
            }
            _ => panic!("Expected Complete"),
        }
    }

    #[test]
    fn test_parse_complete_without_pipe() {
        let response = "COMPLETE";
        let decision = parse_arbiter_response(response).unwrap();

        match decision {
            ArbiterDecision::Complete { reasoning } => {
                assert!(reasoning.is_empty());
            }
            _ => panic!("Expected Complete"),
        }
    }

    #[test]
    fn test_parse_retry_with_reasoning() {
        let response = "RETRY | The developer encountered an error, try again";
        let decision = parse_arbiter_response(response).unwrap();

        match decision {
            ArbiterDecision::Retry { reasoning } => {
                assert_eq!(reasoning, "The developer encountered an error, try again");
            }
            _ => panic!("Expected Retry"),
        }
    }

    #[test]
    fn test_parse_invalid_response() {
        let response = "I think we should use the developer agent";
        let result = parse_arbiter_response(response);

        assert!(result.is_err());
    }

    #[test]
    fn test_parse_with_whitespace() {
        let response = "  SELECT:   developer   |   reason here   ";
        let decision = parse_arbiter_response(response).unwrap();

        match decision {
            ArbiterDecision::SelectAgent {
                agent_name,
                reasoning,
            } => {
                assert_eq!(agent_name, "developer");
                assert_eq!(reasoning, "reason here");
            }
            _ => panic!("Expected SelectAgent"),
        }
    }

    #[test]
    fn test_arbiter_config_default() {
        let config = ArbiterConfig::default();
        assert_eq!(config.agent_name, "arbiter");
        assert_eq!(config.max_iterations, 50);
    }

    #[test]
    fn test_arbiter_format_initial_prompt() {
        let arbiter = Arbiter::with_defaults();
        let registry = AgentRegistry::new();

        let prompt = arbiter.format_initial_prompt(&registry, "Fix the bug in main.rs");

        assert!(prompt.contains("Fix the bug in main.rs"));
        assert!(prompt.contains("Current Task"));
        assert!(prompt.contains("Available Agents"));
        assert!(prompt.contains("No previous executions"));
    }

    #[test]
    fn test_arbiter_format_context_prompt() {
        let arbiter = Arbiter::with_defaults();

        let mut config = default_config();
        config.agents.insert(
            "developer".to_string(),
            create_test_agent("developer", "Use when code needs to be written"),
        );
        config.agents.insert(
            "reviewer".to_string(),
            create_test_agent("reviewer", "Use after code changes to review"),
        );

        let registry = AgentRegistry::from_config(&config).unwrap();

        let mut context = TaskContext::new(TaskId::generate(), "Implement feature X".to_string());
        context.record_invocation(
            "developer".to_string(),
            "developer".to_string(), // display name
            AgentResult {
                status: AgentResultStatus::Success,
                output: "Code implemented".to_string(),
                tool_calls: vec![],
            },
        );

        let prompt = arbiter.format_context_prompt(&registry, &context);

        assert!(prompt.contains("Implement feature X"));
        assert!(prompt.contains("developer"));
        assert!(prompt.contains("Code implemented"));
        assert!(prompt.contains("Iterations: 1/"));
    }

    #[test]
    fn test_arbiter_format_history() {
        let arbiter = Arbiter::with_defaults();

        let mut context = TaskContext::new(TaskId::generate(), "Test task".to_string());
        context.record_invocation(
            "planner".to_string(),
            "planner".to_string(), // display name
            AgentResult {
                status: AgentResultStatus::Success,
                output: "Plan created".to_string(),
                tool_calls: vec![],
            },
        );
        context.record_invocation(
            "developer".to_string(),
            "developer".to_string(), // display name
            AgentResult {
                status: AgentResultStatus::Failure,
                output: "Build failed".to_string(),
                tool_calls: vec![],
            },
        );

        let history = arbiter.format_history(&context);

        assert!(history.contains("Step 1"));
        assert!(history.contains("planner"));
        assert!(history.contains("SUCCESS"));
        assert!(history.contains("Step 2"));
        assert!(history.contains("developer"));
        assert!(history.contains("FAILURE"));
    }

    #[test]
    fn test_arbiter_validate_decision_unknown_agent() {
        let arbiter = Arbiter::with_defaults();
        let registry = AgentRegistry::new();
        let context = TaskContext::new(TaskId::generate(), "Test".to_string());

        let decision = ArbiterDecision::SelectAgent {
            agent_name: "nonexistent".to_string(),
            reasoning: "test".to_string(),
        };

        let result = arbiter.validate_decision(&decision, &registry, &context);
        assert!(result.is_err());
    }

    #[test]
    fn test_arbiter_validate_decision_valid_agent() {
        let arbiter = Arbiter::with_defaults();

        let mut config = default_config();
        config.agents.insert(
            "developer".to_string(),
            create_test_agent("developer", "Use when code needs to be written"),
        );
        config.agents.insert(
            "reviewer".to_string(),
            create_test_agent("reviewer", "Use after code changes to review"),
        );

        let registry = AgentRegistry::from_config(&config).unwrap();

        let context = TaskContext::new(TaskId::generate(), "Test".to_string());

        let decision = ArbiterDecision::SelectAgent {
            agent_name: "reviewer".to_string(),
            reasoning: "test".to_string(),
        };

        let result = arbiter.validate_decision(&decision, &registry, &context);
        assert!(result.is_ok());
    }

    #[test]
    fn test_arbiter_validate_retry_without_history() {
        let arbiter = Arbiter::with_defaults();
        let registry = AgentRegistry::new();
        let context = TaskContext::new(TaskId::generate(), "Test".to_string());

        let decision = ArbiterDecision::Retry {
            reasoning: "test".to_string(),
        };

        let result = arbiter.validate_decision(&decision, &registry, &context);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Cannot retry"));
    }

    #[test]
    fn test_arbiter_decision_equality() {
        let d1 = ArbiterDecision::SelectAgent {
            agent_name: "dev".to_string(),
            reasoning: "reason".to_string(),
        };
        let d2 = ArbiterDecision::SelectAgent {
            agent_name: "dev".to_string(),
            reasoning: "reason".to_string(),
        };
        let d3 = ArbiterDecision::Complete {
            reasoning: "done".to_string(),
        };

        assert_eq!(d1, d2);
        assert_ne!(d1, d3);
    }
}

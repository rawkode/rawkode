//! Orchestration driver for the FSM state machine.
//!
//! The driver bridges the synchronous FSM with async operations like
//! arbiter calls and agent prompts. It runs the event loop, performs
//! async work, and generates events to drive the state machine.

use std::path::PathBuf;

use statig::blocking::StateMachine;
use statig::prelude::*;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::acp::{AgentOutput, AgentPool};
use crate::agent::AgentRegistry;
use crate::arbiter::{Arbiter, ArbiterConfig, ArbiterDecision};
use crate::config::RawkoConfig;
use crate::fsm::{Orchestrator, OrchestratorEvent, State};
use crate::types::{AgentResult, AgentResultStatus, TaskId};
use crate::{Error, Result};

/// Configuration for the orchestration driver.
#[derive(Debug, Clone)]
pub struct DriverConfig {
    /// Maximum number of agent iterations per task.
    pub max_iterations: u32,
    /// Working directory for agents.
    pub cwd: PathBuf,
}

impl Default for DriverConfig {
    fn default() -> Self {
        Self {
            max_iterations: 50,
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

impl DriverConfig {
    /// Create a new driver config with the specified working directory.
    pub fn with_cwd(cwd: PathBuf) -> Self {
        Self {
            cwd,
            ..Default::default()
        }
    }
}

/// Output events streamed from the driver during task execution.
#[derive(Debug, Clone)]
pub enum TaskOutput {
    /// Task has started processing.
    TaskStarted {
        task_id: TaskId,
    },
    /// An agent has been selected by the arbiter.
    AgentSelected {
        /// Agent key used for coordination.
        agent_name: String,
        /// Display name for user-facing output.
        display_name: String,
        reasoning: String,
    },
    /// Text output from the currently executing agent.
    AgentText(String),
    /// An agent has completed its execution.
    AgentCompleted {
        /// Agent key used for coordination.
        agent_name: String,
        /// Display name for user-facing output.
        display_name: String,
        status: AgentResultStatus,
    },
    /// The arbiter has evaluated the task progress.
    Evaluation {
        decision: String,
        reasoning: String,
    },
    /// The task has completed (successfully or not).
    TaskCompleted {
        task_id: TaskId,
        success: bool,
    },
    /// An error occurred during processing.
    Error {
        message: String,
    },
}

/// The orchestration driver that runs the FSM event loop.
///
/// The driver coordinates the state machine, arbiter, and agent pool
/// to execute tasks. It handles async operations and generates events
/// to drive state transitions.
pub struct OrchestratorDriver {
    /// The FSM state machine.
    state_machine: StateMachine<Orchestrator>,
    /// The arbiter for agent selection decisions.
    arbiter: Arbiter,
    /// The agent pool for managing connections.
    pool: AgentPool,
    /// Agent registry for looking up agent definitions.
    registry: AgentRegistry,
    /// Driver configuration.
    config: DriverConfig,
    /// Channel for receiving agent output during execution.
    agent_output_rx: mpsc::UnboundedReceiver<AgentOutput>,
    /// Channel sender (kept for potential dynamic pool creation).
    _agent_output_tx: mpsc::UnboundedSender<AgentOutput>,
}

impl OrchestratorDriver {
    /// Creates a new orchestration driver.
    ///
    /// # Arguments
    /// * `config` - Driver configuration
    /// * `app_config` - Application configuration with agent definitions
    pub fn new(config: DriverConfig, app_config: &RawkoConfig) -> Result<Self> {
        let registry = AgentRegistry::from_config(app_config)?;
        let (agent_output_tx, agent_output_rx) = mpsc::unbounded_channel();

        let pool = AgentPool::new(
            app_config.agents.clone(),
            config.cwd.clone(),
            agent_output_tx.clone(),
        );

        let arbiter = Arbiter::new(ArbiterConfig {
            agent_name: "arbiter".to_string(),
            max_iterations: config.max_iterations,
        });

        let orchestrator = Orchestrator::new(registry.clone());
        let state_machine = orchestrator.state_machine();

        Ok(Self {
            state_machine,
            arbiter,
            pool,
            registry,
            config,
            agent_output_rx,
            _agent_output_tx: agent_output_tx,
        })
    }

    /// Runs a task through the orchestration loop.
    ///
    /// Returns a receiver for streaming task output and the task ID.
    /// The caller can use the cancellation token to stop the task.
    ///
    /// # Arguments
    /// * `request` - The task request string
    /// * `cancel_token` - Token for cancelling the task
    ///
    /// # Returns
    /// A tuple of (TaskId, output receiver)
    pub async fn run_task(
        &mut self,
        request: String,
        cancel_token: CancellationToken,
    ) -> (TaskId, mpsc::UnboundedReceiver<TaskOutput>) {
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        let task_id = TaskId::generate();

        // Emit TaskStarted
        let _ = output_tx.send(TaskOutput::TaskStarted {
            task_id: task_id.clone(),
        });

        // Send TaskReceived event to transition to Selecting
        self.state_machine.handle(&OrchestratorEvent::TaskReceived {
            task_id: task_id.clone(),
            request: request.clone(),
        });

        // Run the orchestration loop
        self.orchestration_loop(&output_tx, cancel_token, &request)
            .await;

        // Determine success based on final state
        let success = matches!(self.state_machine.state(), State::Idle {});

        let _ = output_tx.send(TaskOutput::TaskCompleted {
            task_id: task_id.clone(),
            success,
        });

        (task_id, output_rx)
    }

    /// The main orchestration loop.
    async fn orchestration_loop(
        &mut self,
        output_tx: &mpsc::UnboundedSender<TaskOutput>,
        cancel_token: CancellationToken,
        initial_request: &str,
    ) {
        loop {
            // Check for cancellation
            if cancel_token.is_cancelled() {
                tracing::info!("Task cancelled by user");
                self.state_machine
                    .handle(&OrchestratorEvent::Cancel);
                break;
            }

            match self.state_machine.state().clone() {
                State::Idle {} => {
                    // Task is complete, exit the loop
                    break;
                }
                State::Selecting {} => {
                    if let Err(e) = self
                        .handle_selecting(output_tx, initial_request)
                        .await
                    {
                        let _ = output_tx.send(TaskOutput::Error {
                            message: e.to_string(),
                        });
                        self.state_machine
                            .handle(&OrchestratorEvent::Cancel);
                        break;
                    }
                }
                State::Executing { agent_name } => {
                    if let Err(e) = self
                        .handle_executing(output_tx, &agent_name, &cancel_token)
                        .await
                    {
                        let _ = output_tx.send(TaskOutput::Error {
                            message: e.to_string(),
                        });
                        self.state_machine
                            .handle(&OrchestratorEvent::AgentFailed {
                                error: e.to_string(),
                            });
                    }
                }
                State::Evaluating {} => {
                    if let Err(e) = self.handle_evaluating(output_tx).await {
                        let _ = output_tx.send(TaskOutput::Error {
                            message: e.to_string(),
                        });
                        self.state_machine
                            .handle(&OrchestratorEvent::Cancel);
                        break;
                    }
                }
            }
        }
    }

    /// Handles the Selecting state by calling the arbiter.
    async fn handle_selecting(
        &mut self,
        output_tx: &mpsc::UnboundedSender<TaskOutput>,
        initial_request: &str,
    ) -> Result<()> {
        let cwd = self.config.cwd.clone();

        // Determine if this is the initial selection or a continuation
        let decision = if let Some(ref context) = self.state_machine.inner().current_task {
            if context.agent_history.is_empty() {
                // Initial selection
                self.arbiter
                    .select_initial_agent(&self.registry, initial_request, cwd)
                    .await?
            } else {
                // Continuation
                self.arbiter
                    .select_next_agent(&self.registry, context, cwd)
                    .await?
            }
        } else {
            return Err(Error::Agent {
                message: "No task context available during selection".to_string(),
            });
        };

        match decision {
            ArbiterDecision::SelectAgent {
                agent_name,
                reasoning,
            } => {
                // Get display name from registry, falling back to agent_name if not found
                let display_name = self.registry
                    .get(&agent_name)
                    .map(|def| def.display_name(&agent_name).to_string())
                    .unwrap_or_else(|| agent_name.clone());

                let _ = output_tx.send(TaskOutput::AgentSelected {
                    agent_name: agent_name.clone(),
                    display_name,
                    reasoning: reasoning.clone(),
                });

                self.state_machine
                    .handle(&OrchestratorEvent::AgentSelected { agent_name });
            }
            ArbiterDecision::Complete { reasoning } => {
                let _ = output_tx.send(TaskOutput::Evaluation {
                    decision: "complete".to_string(),
                    reasoning,
                });

                self.state_machine
                    .handle(&OrchestratorEvent::TaskComplete);
            }
            ArbiterDecision::Retry { reasoning } => {
                let _ = output_tx.send(TaskOutput::Evaluation {
                    decision: "retry".to_string(),
                    reasoning,
                });

                // For retry, we need to get the last agent name and re-select
                // This transitions back to selecting which will try again
                // The arbiter will handle the retry logic
                self.state_machine
                    .handle(&OrchestratorEvent::ContinueTask);
            }
        }

        Ok(())
    }

    /// Handles the Executing state by calling the selected agent.
    async fn handle_executing(
        &mut self,
        output_tx: &mpsc::UnboundedSender<TaskOutput>,
        agent_name: &str,
        cancel_token: &CancellationToken,
    ) -> Result<()> {
        let cwd = self.config.cwd.clone();

        // Build the prompt from task context first (before mutable borrow)
        let prompt = self.build_agent_prompt(agent_name)?;

        // Get or spawn the agent connection
        let conn = self.pool.get_or_spawn(agent_name).await?;

        // Create session if needed
        if conn.session_id().is_none() {
            conn.new_session(cwd).await?;
        }

        // Send the prompt - this waits for completion
        conn.prompt(&prompt).await?;

        // Collect output from the channel
        let mut output_text = String::new();
        let mut cancelled = false;

        // Drain the output channel
        loop {
            tokio::select! {
                _ = cancel_token.cancelled() => {
                    // Cancel the agent
                    let _ = conn.cancel().await;
                    cancelled = true;
                    break;
                }
                result = self.agent_output_rx.recv() => {
                    match result {
                        Some(AgentOutput::Text(text)) => {
                            let _ = output_tx.send(TaskOutput::AgentText(text.clone()));
                            output_text.push_str(&text);
                        }
                        Some(AgentOutput::Other(desc)) => {
                            tracing::debug!("Non-text agent output: {}", desc);
                        }
                        None => {
                            // Channel closed, agent done
                            break;
                        }
                    }
                }
                // Short timeout to check if more output is coming
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                    // Try non-blocking receive
                    match self.agent_output_rx.try_recv() {
                        Ok(AgentOutput::Text(text)) => {
                            let _ = output_tx.send(TaskOutput::AgentText(text.clone()));
                            output_text.push_str(&text);
                        }
                        Ok(AgentOutput::Other(desc)) => {
                            tracing::debug!("Non-text agent output: {}", desc);
                        }
                        Err(mpsc::error::TryRecvError::Empty) => {
                            // No more output, prompt is done
                            break;
                        }
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            break;
                        }
                    }
                }
            }
        }

        if cancelled {
            return Err(Error::Agent {
                message: "Task cancelled".to_string(),
            });
        }

        // Build the result
        let status = AgentResultStatus::Success;
        let result = AgentResult {
            status,
            output: output_text,
            tool_calls: vec![], // We don't track tool calls at this level
        };

        // Get display name from registry, falling back to agent_name if not found
        let display_name = self.registry
            .get(agent_name)
            .map(|def| def.display_name(agent_name).to_string())
            .unwrap_or_else(|| agent_name.to_string());

        let _ = output_tx.send(TaskOutput::AgentCompleted {
            agent_name: agent_name.to_string(),
            display_name,
            status,
        });

        self.state_machine
            .handle(&OrchestratorEvent::AgentComplete { result });

        Ok(())
    }

    /// Handles the Evaluating state by calling the arbiter for evaluation.
    async fn handle_evaluating(
        &mut self,
        output_tx: &mpsc::UnboundedSender<TaskOutput>,
    ) -> Result<()> {
        let cwd = self.config.cwd.clone();

        // Get the task context for evaluation
        let context = self
            .state_machine
            .inner()
            .current_task
            .as_ref()
            .ok_or_else(|| Error::Agent {
                message: "No task context available during evaluation".to_string(),
            })?
            .clone();

        // Ask the arbiter for the next step
        let decision = self
            .arbiter
            .select_next_agent(&self.registry, &context, cwd)
            .await?;

        match decision {
            ArbiterDecision::SelectAgent {
                agent_name,
                reasoning,
            } => {
                let _ = output_tx.send(TaskOutput::Evaluation {
                    decision: format!("continue with {}", agent_name),
                    reasoning,
                });

                // ContinueTask will transition back to Selecting
                self.state_machine
                    .handle(&OrchestratorEvent::ContinueTask);
            }
            ArbiterDecision::Complete { reasoning } => {
                let _ = output_tx.send(TaskOutput::Evaluation {
                    decision: "complete".to_string(),
                    reasoning,
                });

                self.state_machine
                    .handle(&OrchestratorEvent::TaskComplete);
            }
            ArbiterDecision::Retry { reasoning } => {
                let _ = output_tx.send(TaskOutput::Evaluation {
                    decision: "retry".to_string(),
                    reasoning,
                });

                // ContinueTask will go back to Selecting
                self.state_machine
                    .handle(&OrchestratorEvent::ContinueTask);
            }
        }

        Ok(())
    }

    /// Builds the prompt for an agent based on task context.
    fn build_agent_prompt(&self, agent_name: &str) -> Result<String> {
        let context = self
            .state_machine
            .inner()
            .current_task
            .as_ref()
            .ok_or_else(|| Error::Agent {
                message: "No task context available".to_string(),
            })?;

        // Get the agent definition for any special instructions
        let agent_def = self.registry.get(agent_name).ok_or_else(|| Error::Agent {
            message: format!("Agent '{}' not found", agent_name),
        })?;

        let mut prompt = String::new();

        // Add task request
        prompt.push_str("## Task\n");
        prompt.push_str(&context.request);
        prompt.push_str("\n\n");

        // Add history if available
        if !context.agent_history.is_empty() {
            prompt.push_str("## Previous Work\n");
            for (i, invocation) in context.agent_history.iter().enumerate() {
                // Show both key and display name if they differ
                let agent_label = if invocation.agent_name == invocation.display_name {
                    invocation.display_name.clone()
                } else {
                    format!("{} ({})", invocation.agent_name, invocation.display_name)
                };
                prompt.push_str(&format!(
                    "### Step {} - {} ({})\n{}\n\n",
                    i + 1,
                    agent_label,
                    match invocation.result.status {
                        AgentResultStatus::Success => "success",
                        AgentResultStatus::Failure => "failed",
                        AgentResultStatus::NeedsRetry => "needs retry",
                    },
                    invocation.result.output
                ));
            }
        }

        // Add agent-specific instructions from prompt
        if !agent_def.prompt.is_empty() {
            prompt.push_str("## Your Role\n");
            prompt.push_str(&agent_def.prompt);
            prompt.push_str("\n\n");
        }

        prompt.push_str("## Instructions\n");
        prompt.push_str("Complete your part of the task. Be thorough but concise.\n");

        Ok(prompt)
    }

    /// Shuts down the driver, cleaning up arbiter and pool.
    pub async fn shutdown(&mut self) -> Result<()> {
        tracing::info!("Shutting down orchestration driver");

        // Shutdown arbiter
        self.arbiter.shutdown().await?;

        // Shutdown all agents in the pool
        self.pool.shutdown_all().await;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_driver_config_default() {
        let config = DriverConfig::default();
        assert_eq!(config.max_iterations, 50);
    }

    #[test]
    fn test_driver_config_with_cwd() {
        let config = DriverConfig::with_cwd(PathBuf::from("/tmp"));
        assert_eq!(config.cwd, PathBuf::from("/tmp"));
    }

    #[test]
    fn test_task_output_variants() {
        let task_id = TaskId::generate();

        let started = TaskOutput::TaskStarted {
            task_id: task_id.clone(),
        };
        assert!(matches!(started, TaskOutput::TaskStarted { .. }));

        let selected = TaskOutput::AgentSelected {
            agent_name: "developer".to_string(),
            display_name: "Developer".to_string(),
            reasoning: "test".to_string(),
        };
        assert!(matches!(selected, TaskOutput::AgentSelected { .. }));

        let text = TaskOutput::AgentText("Hello".to_string());
        assert!(matches!(text, TaskOutput::AgentText(_)));

        let completed = TaskOutput::AgentCompleted {
            agent_name: "developer".to_string(),
            display_name: "Developer".to_string(),
            status: AgentResultStatus::Success,
        };
        assert!(matches!(completed, TaskOutput::AgentCompleted { .. }));

        let evaluation = TaskOutput::Evaluation {
            decision: "complete".to_string(),
            reasoning: "done".to_string(),
        };
        assert!(matches!(evaluation, TaskOutput::Evaluation { .. }));

        let task_completed = TaskOutput::TaskCompleted {
            task_id: task_id.clone(),
            success: true,
        };
        assert!(matches!(task_completed, TaskOutput::TaskCompleted { .. }));

        let error = TaskOutput::Error {
            message: "error".to_string(),
        };
        assert!(matches!(error, TaskOutput::Error { .. }));
    }
}

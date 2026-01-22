//! FSM Orchestration module for rawko
//!
//! This module implements the state machine that orchestrates agent execution.
//! The orchestrator manages the lifecycle of tasks, from receiving them to
//! completion, coordinating between the arbiter (for agent selection) and
//! the agent pool (for execution).

use crate::types::{AgentResult, TaskId};
use crate::AgentRegistry;
use statig::prelude::*;

/// Events that drive the orchestrator state machine
#[derive(Debug, Clone)]
pub enum OrchestratorEvent {
    /// A new task has been received
    TaskReceived {
        task_id: TaskId,
        request: String,
    },
    /// An agent has been selected by the arbiter
    AgentSelected {
        agent_name: String,
    },
    /// An agent completed its execution successfully
    AgentComplete {
        result: AgentResult,
    },
    /// An agent failed during execution
    AgentFailed {
        error: String,
    },
    /// The task has been evaluated as complete
    TaskComplete,
    /// The task needs another agent iteration
    ContinueTask,
    /// Cancel the current task
    Cancel,
}

/// Shared storage for the orchestrator state machine
#[derive(Debug)]
pub struct Orchestrator {
    /// The agent registry for looking up agent definitions
    pub registry: AgentRegistry,
    /// Current task being processed (if any)
    pub current_task: Option<TaskContext>,
}

/// Context for the currently executing task
#[derive(Debug, Clone)]
pub struct TaskContext {
    /// Unique identifier for this task
    pub task_id: TaskId,
    /// The original task request
    pub request: String,
    /// History of agent invocations for this task
    pub agent_history: Vec<AgentInvocation>,
    /// Number of failed attempts
    pub failure_count: u32,
    /// Maximum allowed failures before giving up
    pub max_failures: u32,
}

impl TaskContext {
    /// Create a new task context
    pub fn new(task_id: TaskId, request: String) -> Self {
        Self {
            task_id,
            request,
            agent_history: Vec::new(),
            failure_count: 0,
            max_failures: 3,
        }
    }

    /// Record an agent invocation
    pub fn record_invocation(&mut self, agent_name: String, display_name: String, result: AgentResult) {
        self.agent_history.push(AgentInvocation {
            agent_name,
            display_name,
            result,
        });
    }

    /// Record a failure
    pub fn record_failure(&mut self) {
        self.failure_count += 1;
    }

    /// Check if max failures has been reached
    pub fn max_failures_reached(&self) -> bool {
        self.failure_count >= self.max_failures
    }
}

/// Record of a single agent invocation
#[derive(Debug, Clone)]
pub struct AgentInvocation {
    /// Key of the agent that was invoked (used for coordination)
    pub agent_name: String,
    /// Display name of the agent (for user-facing output)
    pub display_name: String,
    /// Result from the agent
    pub result: AgentResult,
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self {
            registry: AgentRegistry::default(),
            current_task: None,
        }
    }
}

impl Orchestrator {
    /// Create a new orchestrator with the given agent registry
    pub fn new(registry: AgentRegistry) -> Self {
        Self {
            registry,
            current_task: None,
        }
    }

    /// Set the current task
    pub fn set_task(&mut self, task_id: TaskId, request: String) {
        self.current_task = Some(TaskContext::new(task_id, request));
    }

    /// Clear the current task
    pub fn clear_task(&mut self) {
        self.current_task = None;
    }
}

/// The orchestrator state machine implementation
#[state_machine(
    initial = "State::idle()",
    state(derive(Debug, Clone, PartialEq, Eq))
)]
impl Orchestrator {
    /// Idle state - waiting for a task
    ///
    /// The orchestrator starts in this state and returns here after
    /// completing or cancelling a task.
    #[state]
    fn idle(&mut self, event: &OrchestratorEvent) -> Outcome<State> {
        match event {
            OrchestratorEvent::TaskReceived { task_id, request } => {
                tracing::info!(task_id = %task_id, "Received new task");
                self.set_task(task_id.clone(), request.clone());
                Transition(State::selecting())
            }
            _ => {
                tracing::debug!("Ignoring event in idle state: {:?}", event);
                Handled
            }
        }
    }

    /// Selecting state - arbiter is deciding which agent to invoke
    ///
    /// In this state, the arbiter evaluates the task context and
    /// determines which agent should handle the next step.
    #[state]
    fn selecting(&mut self, event: &OrchestratorEvent) -> Outcome<State> {
        match event {
            OrchestratorEvent::AgentSelected { agent_name } => {
                tracing::info!(agent = %agent_name, "Agent selected");
                Transition(State::executing(agent_name.clone()))
            }
            OrchestratorEvent::TaskComplete => {
                tracing::info!("Task marked as complete during selection");
                self.clear_task();
                Transition(State::idle())
            }
            OrchestratorEvent::Cancel => {
                tracing::info!("Task cancelled during selection");
                self.clear_task();
                Transition(State::idle())
            }
            _ => {
                tracing::debug!("Ignoring event in selecting state: {:?}", event);
                Handled
            }
        }
    }

    /// Executing state - sending prompt to the selected agent
    ///
    /// In this state, the prompt is sent to the selected agent via ACP
    /// and we wait for the agent to complete or fail.
    #[state]
    fn executing(&mut self, agent_name: &String, event: &OrchestratorEvent) -> Outcome<State> {
        match event {
            OrchestratorEvent::AgentComplete { result } => {
                tracing::info!(agent = %agent_name, "Agent completed execution");
                if let Some(ref mut task) = self.current_task {
                    // Get display name from registry, falling back to agent_name if not found
                    let display_name = self.registry
                        .get(agent_name)
                        .map(|def| def.display_name(agent_name).to_string())
                        .unwrap_or_else(|| agent_name.clone());
                    task.record_invocation(agent_name.clone(), display_name, result.clone());
                }
                Transition(State::evaluating())
            }
            OrchestratorEvent::AgentFailed { error } => {
                tracing::warn!(agent = %agent_name, error = %error, "Agent failed");
                if let Some(ref mut task) = self.current_task {
                    task.record_failure();
                    if task.max_failures_reached() {
                        tracing::error!("Max failures reached, task failed");
                        self.clear_task();
                        return Transition(State::idle());
                    }
                }
                // Go back to selecting to try another agent
                Transition(State::selecting())
            }
            OrchestratorEvent::Cancel => {
                tracing::info!("Task cancelled during execution");
                self.clear_task();
                Transition(State::idle())
            }
            _ => {
                tracing::debug!("Ignoring event in executing state: {:?}", event);
                Handled
            }
        }
    }

    /// Evaluating state - checking if the task is complete
    ///
    /// In this state, we evaluate the result from the agent to determine
    /// if the task is complete or if we need another iteration.
    #[state]
    fn evaluating(&mut self, event: &OrchestratorEvent) -> Outcome<State> {
        match event {
            OrchestratorEvent::TaskComplete => {
                tracing::info!("Task completed successfully");
                self.clear_task();
                Transition(State::idle())
            }
            OrchestratorEvent::ContinueTask => {
                tracing::info!("Task needs more work, continuing");
                Transition(State::selecting())
            }
            OrchestratorEvent::Cancel => {
                tracing::info!("Task cancelled during evaluation");
                self.clear_task();
                Transition(State::idle())
            }
            _ => {
                tracing::debug!("Ignoring event in evaluating state: {:?}", event);
                Handled
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentResultStatus;

    fn create_test_orchestrator() -> Orchestrator {
        Orchestrator::default()
    }

    #[test]
    fn test_initial_state_is_idle() {
        let orchestrator = create_test_orchestrator();
        let sm = orchestrator.state_machine();
        assert_eq!(*sm.state(), State::Idle {});
    }

    #[test]
    fn test_task_received_transitions_to_selecting() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });

        assert_eq!(*sm.state(), State::Selecting {});
    }

    #[test]
    fn test_agent_selected_transitions_to_executing() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentSelected {
            agent_name: "developer".to_string(),
        });

        assert_eq!(
            *sm.state(),
            State::Executing {
                agent_name: "developer".to_string()
            }
        );
    }

    #[test]
    fn test_agent_complete_transitions_to_evaluating() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentSelected {
            agent_name: "developer".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentComplete {
            result: AgentResult {
                status: AgentResultStatus::Success,
                output: "Done".to_string(),
                tool_calls: vec![],
            },
        });

        assert_eq!(*sm.state(), State::Evaluating {});
    }

    #[test]
    fn test_task_complete_returns_to_idle() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentSelected {
            agent_name: "developer".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentComplete {
            result: AgentResult {
                status: AgentResultStatus::Success,
                output: "Done".to_string(),
                tool_calls: vec![],
            },
        });
        sm.handle(&OrchestratorEvent::TaskComplete);

        assert_eq!(*sm.state(), State::Idle {});
    }

    #[test]
    fn test_continue_task_returns_to_selecting() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentSelected {
            agent_name: "developer".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentComplete {
            result: AgentResult {
                status: AgentResultStatus::Success,
                output: "Partial work done".to_string(),
                tool_calls: vec![],
            },
        });
        sm.handle(&OrchestratorEvent::ContinueTask);

        assert_eq!(*sm.state(), State::Selecting {});
    }

    #[test]
    fn test_cancel_returns_to_idle() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });
        sm.handle(&OrchestratorEvent::Cancel);

        assert_eq!(*sm.state(), State::Idle {});
    }

    #[test]
    fn test_agent_failure_goes_back_to_selecting() {
        let orchestrator = create_test_orchestrator();
        let mut sm = orchestrator.state_machine();

        sm.handle(&OrchestratorEvent::TaskReceived {
            task_id: TaskId::generate(),
            request: "Test task".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentSelected {
            agent_name: "developer".to_string(),
        });
        sm.handle(&OrchestratorEvent::AgentFailed {
            error: "Connection lost".to_string(),
        });

        assert_eq!(*sm.state(), State::Selecting {});
    }

    #[test]
    fn test_task_context_tracks_invocations() {
        let task_id = TaskId::generate();
        let mut ctx = TaskContext::new(task_id, "Test".to_string());

        assert_eq!(ctx.agent_history.len(), 0);
        assert_eq!(ctx.failure_count, 0);

        ctx.record_invocation(
            "developer".to_string(),
            "Developer".to_string(), // display name
            AgentResult {
                status: AgentResultStatus::Success,
                output: "Done".to_string(),
                tool_calls: vec![],
            },
        );

        assert_eq!(ctx.agent_history.len(), 1);
        assert_eq!(ctx.agent_history[0].agent_name, "developer");
        assert_eq!(ctx.agent_history[0].display_name, "Developer");
    }

    #[test]
    fn test_max_failures_tracking() {
        let task_id = TaskId::generate();
        let mut ctx = TaskContext::new(task_id, "Test".to_string());
        ctx.max_failures = 2;

        assert!(!ctx.max_failures_reached());

        ctx.record_failure();
        assert!(!ctx.max_failures_reached());

        ctx.record_failure();
        assert!(ctx.max_failures_reached());
    }
}

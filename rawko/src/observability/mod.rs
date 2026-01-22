//! Observability module for rawko
//!
//! Provides a custom tracing layer that handles:
//! - Streaming agent output (text, thinking)
//! - Status messages with formatting
//! - Verbosity-based filtering

use std::io::{self, Write};

use tracing::field::{Field, Visit};
use tracing::span::Attributes;
use tracing::{Event, Id, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// Verbosity level for terminal output
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verbosity {
    /// Only errors and final results
    Quiet = 0,
    /// Status messages (agent selected, task complete)
    Normal = 1,
    /// Agent text output
    Verbose = 2,
    /// Everything including thinking
    Debug = 3,
}

impl From<u8> for Verbosity {
    fn from(v: u8) -> Self {
        match v {
            0 => Verbosity::Quiet,
            1 => Verbosity::Normal,
            2 => Verbosity::Verbose,
            _ => Verbosity::Debug,
        }
    }
}

/// Custom tracing layer for terminal output
///
/// Handles formatting and filtering based on verbosity level.
/// Different event targets get different formatting:
/// - `rawko::agent::text` - streamed raw (no prefix)
/// - `rawko::agent::thinking` - streamed with dim formatting (verbose+)
/// - `rawko::status` - prefixed with `[rawko]`
/// - `rawko::error` - prefixed with `[rawko] Error:`
pub struct TerminalLayer {
    verbosity: Verbosity,
}

impl TerminalLayer {
    /// Create a new terminal layer with the specified verbosity
    pub fn new(verbosity: Verbosity) -> Self {
        Self { verbosity }
    }

    /// Check if a target should be displayed at current verbosity
    fn should_display(&self, target: &str, level: Level) -> bool {
        match target {
            // Errors always shown
            t if t.starts_with("rawko::error") => true,
            // Final results always shown
            t if t.starts_with("rawko::result") => true,
            // Status needs Normal+
            t if t.starts_with("rawko::status") => self.verbosity >= Verbosity::Normal,
            // Agent text needs Verbose+
            t if t.starts_with("rawko::agent::text") => self.verbosity >= Verbosity::Verbose,
            // Thinking needs Debug
            t if t.starts_with("rawko::agent::thinking") => self.verbosity >= Verbosity::Debug,
            // Other rawko events based on level
            t if t.starts_with("rawko") => match level {
                Level::ERROR => true,
                Level::WARN => self.verbosity >= Verbosity::Normal,
                Level::INFO => self.verbosity >= Verbosity::Normal,
                Level::DEBUG => self.verbosity >= Verbosity::Verbose,
                Level::TRACE => self.verbosity >= Verbosity::Debug,
            },
            // Non-rawko events only at debug
            _ => self.verbosity >= Verbosity::Debug && level <= Level::DEBUG,
        }
    }
}

/// Visitor to extract fields from tracing events
struct FieldVisitor {
    message: Option<String>,
    text: Option<String>,
    agent: Option<String>,
    reasoning: Option<String>,
    task_id: Option<String>,
    success: Option<bool>,
    decision: Option<String>,
}

impl FieldVisitor {
    fn new() -> Self {
        Self {
            message: None,
            text: None,
            agent: None,
            reasoning: None,
            task_id: None,
            success: None,
            decision: None,
        }
    }
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" => self.message = Some(format!("{:?}", value)),
            "text" => self.text = Some(format!("{:?}", value).trim_matches('"').to_string()),
            "agent" => self.agent = Some(format!("{:?}", value).trim_matches('"').to_string()),
            "reasoning" => {
                self.reasoning = Some(format!("{:?}", value).trim_matches('"').to_string())
            }
            "task_id" => self.task_id = Some(format!("{:?}", value).trim_matches('"').to_string()),
            "decision" => {
                self.decision = Some(format!("{:?}", value).trim_matches('"').to_string())
            }
            _ => {}
        }
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        if field.name() == "success" {
            self.success = Some(value);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => self.message = Some(value.to_string()),
            "text" => self.text = Some(value.to_string()),
            "agent" => self.agent = Some(value.to_string()),
            "reasoning" => self.reasoning = Some(value.to_string()),
            "task_id" => self.task_id = Some(value.to_string()),
            "decision" => self.decision = Some(value.to_string()),
            _ => {}
        }
    }
}

impl<S> Layer<S> for TerminalLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let target = metadata.target();
        let level = *metadata.level();

        if !self.should_display(target, level) {
            return;
        }

        let mut visitor = FieldVisitor::new();
        event.record(&mut visitor);

        let mut stderr = io::stderr();
        let mut stdout = io::stdout();

        match target {
            // Agent text - stream to stdout without prefix
            "rawko::agent::text" => {
                if let Some(text) = visitor.text {
                    let _ = write!(stdout, "{}", text);
                    let _ = stdout.flush();
                }
            }
            // Agent thinking - stream to stderr with dim formatting
            "rawko::agent::thinking" => {
                if let Some(text) = visitor.text {
                    // Use ANSI dim
                    let _ = write!(stderr, "\x1b[2m{}\x1b[0m", text);
                    let _ = stderr.flush();
                }
            }
            // Status messages
            "rawko::status::agent_selected" => {
                if let (Some(agent), Some(reasoning)) = (visitor.agent, visitor.reasoning) {
                    let _ = writeln!(stderr, "[rawko] Selected agent: {} - {}", agent, reasoning);
                }
            }
            "rawko::status::task_started" => {
                if let Some(task_id) = visitor.task_id {
                    let _ = writeln!(stderr, "[rawko] Task started: {}", task_id);
                }
            }
            "rawko::status::task_completed" => {
                if let (Some(task_id), Some(success)) = (visitor.task_id, visitor.success) {
                    if success {
                        let _ = writeln!(stderr, "[rawko] Task {} completed successfully", task_id);
                    } else {
                        let _ = writeln!(stderr, "[rawko] Task {} failed", task_id);
                    }
                }
            }
            "rawko::status::agent_completed" => {
                if let Some(agent) = visitor.agent {
                    let _ = writeln!(stderr, "[rawko] Agent {} completed", agent);
                }
            }
            "rawko::status::evaluation" => {
                if let (Some(decision), Some(reasoning)) = (visitor.decision, visitor.reasoning) {
                    let _ = writeln!(stderr, "[rawko] Evaluation: {} - {}", decision, reasoning);
                }
            }
            "rawko::status::cancelling" => {
                let _ = writeln!(stderr, "\n[rawko] Cancelling task...");
            }
            // Errors
            "rawko::error" => {
                if let Some(message) = visitor.message {
                    let _ = writeln!(stderr, "[rawko] Error: {}", message);
                }
            }
            // Generic rawko messages
            t if t.starts_with("rawko") => {
                if let Some(message) = visitor.message {
                    let prefix = match level {
                        Level::ERROR => "[rawko] Error: ",
                        Level::WARN => "[rawko] Warning: ",
                        _ => "[rawko] ",
                    };
                    let _ = writeln!(stderr, "{}{}", prefix, message);
                }
            }
            _ => {}
        }
    }

    fn on_new_span(&self, _attrs: &Attributes<'_>, _id: &Id, _ctx: Context<'_, S>) {}
}

/// Convenience macros for emitting rawko events
#[macro_export]
macro_rules! emit_agent_text {
    ($text:expr) => {
        tracing::event!(target: "rawko::agent::text", tracing::Level::INFO, text = $text)
    };
}

#[macro_export]
macro_rules! emit_agent_thinking {
    ($text:expr) => {
        tracing::event!(target: "rawko::agent::thinking", tracing::Level::DEBUG, text = $text)
    };
}

#[macro_export]
macro_rules! emit_status_agent_selected {
    ($agent:expr, $reasoning:expr) => {
        tracing::event!(
            target: "rawko::status::agent_selected",
            tracing::Level::INFO,
            agent = $agent,
            reasoning = $reasoning
        )
    };
}

#[macro_export]
macro_rules! emit_status_task_started {
    ($task_id:expr) => {
        tracing::event!(
            target: "rawko::status::task_started",
            tracing::Level::INFO,
            task_id = $task_id
        )
    };
}

#[macro_export]
macro_rules! emit_status_task_completed {
    ($task_id:expr, $success:expr) => {
        tracing::event!(
            target: "rawko::status::task_completed",
            tracing::Level::INFO,
            task_id = $task_id,
            success = $success
        )
    };
}

#[macro_export]
macro_rules! emit_status_agent_completed {
    ($agent:expr) => {
        tracing::event!(
            target: "rawko::status::agent_completed",
            tracing::Level::INFO,
            agent = $agent
        )
    };
}

#[macro_export]
macro_rules! emit_status_evaluation {
    ($decision:expr, $reasoning:expr) => {
        tracing::event!(
            target: "rawko::status::evaluation",
            tracing::Level::INFO,
            decision = $decision,
            reasoning = $reasoning
        )
    };
}

#[macro_export]
macro_rules! emit_status_cancelling {
    () => {
        tracing::event!(target: "rawko::status::cancelling", tracing::Level::INFO, message = "cancelling")
    };
}

#[macro_export]
macro_rules! emit_error {
    ($message:expr) => {
        tracing::event!(target: "rawko::error", tracing::Level::ERROR, message = $message)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verbosity_from_u8() {
        assert_eq!(Verbosity::from(0), Verbosity::Quiet);
        assert_eq!(Verbosity::from(1), Verbosity::Normal);
        assert_eq!(Verbosity::from(2), Verbosity::Verbose);
        assert_eq!(Verbosity::from(3), Verbosity::Debug);
        assert_eq!(Verbosity::from(10), Verbosity::Debug);
    }

    #[test]
    fn test_verbosity_ordering() {
        assert!(Verbosity::Quiet < Verbosity::Normal);
        assert!(Verbosity::Normal < Verbosity::Verbose);
        assert!(Verbosity::Verbose < Verbosity::Debug);
    }

    #[test]
    fn test_should_display_errors_always() {
        let layer = TerminalLayer::new(Verbosity::Quiet);
        assert!(layer.should_display("rawko::error", Level::ERROR));
    }

    #[test]
    fn test_should_display_status_needs_normal() {
        let quiet = TerminalLayer::new(Verbosity::Quiet);
        let normal = TerminalLayer::new(Verbosity::Normal);

        assert!(!quiet.should_display("rawko::status::task_started", Level::INFO));
        assert!(normal.should_display("rawko::status::task_started", Level::INFO));
    }

    #[test]
    fn test_should_display_agent_text_needs_verbose() {
        let normal = TerminalLayer::new(Verbosity::Normal);
        let verbose = TerminalLayer::new(Verbosity::Verbose);

        assert!(!normal.should_display("rawko::agent::text", Level::INFO));
        assert!(verbose.should_display("rawko::agent::text", Level::INFO));
    }

    #[test]
    fn test_should_display_thinking_needs_debug() {
        let verbose = TerminalLayer::new(Verbosity::Verbose);
        let debug = TerminalLayer::new(Verbosity::Debug);

        assert!(!verbose.should_display("rawko::agent::thinking", Level::DEBUG));
        assert!(debug.should_display("rawko::agent::thinking", Level::DEBUG));
    }
}

pub mod acp;
pub mod agent;
pub mod arbiter;
pub mod config;
pub mod driver;
pub mod error;
pub mod fsm;
pub mod observability;
pub mod types;

pub use acp::{AgentConnection, AgentOutput, AgentPool, RawkoClient};
pub use agent::AgentRegistry;
pub use arbiter::{Arbiter, ArbiterConfig, ArbiterDecision, parse_arbiter_response};
pub use config::{AgentDef, Config};
pub use driver::{DriverConfig, OrchestratorDriver, TaskOutput};
pub use error::{Error, Result};
pub use fsm::{Orchestrator, OrchestratorEvent, TaskContext};
pub use observability::{TerminalLayer, Verbosity};
pub use types::*;

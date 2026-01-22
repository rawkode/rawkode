//! Single agent connection management.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use agent_client_protocol::{
    Agent, CancelNotification, ClientSideConnection, Implementation, InitializeRequest,
    NewSessionRequest, PromptRequest, ProtocolVersion, SessionId,
};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::{AgentOutput, RawkoClient};
use crate::{Error, Result};

/// A connection to a single ACP agent.
pub struct AgentConnection {
    /// The ACP connection for sending requests.
    conn: ClientSideConnection,
    /// The child process handle.
    _child: Child,
    /// Current session ID, if any.
    session_id: Option<SessionId>,
}

impl AgentConnection {
    /// Spawns a new agent process and establishes an ACP connection.
    ///
    /// # Arguments
    /// * `command` - The command to run (e.g., "claude", "gemini")
    /// * `args` - Arguments to pass (e.g., ["--acp"])
    /// * `env` - Additional environment variables
    /// * `cwd` - Working directory for the agent
    /// * `output_tx` - Channel for receiving agent output
    pub async fn spawn(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
        cwd: PathBuf,
        output_tx: mpsc::UnboundedSender<AgentOutput>,
    ) -> Result<Self> {
        // Spawn the agent process
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .current_dir(&cwd)
            .kill_on_drop(true);

        for (key, value) in env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|e| Error::Agent {
            message: format!("Failed to spawn agent '{}': {}", command, e),
        })?;

        let stdin = child.stdin.take().ok_or_else(|| Error::Agent {
            message: "Failed to capture agent stdin".to_string(),
        })?;

        let stdout = child.stdout.take().ok_or_else(|| Error::Agent {
            message: "Failed to capture agent stdout".to_string(),
        })?;

        // Create ACP connection
        let client = RawkoClient::new(output_tx);
        let (conn, io_task) = ClientSideConnection::new(
            client,
            stdin.compat_write(),
            stdout.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );

        // Spawn the I/O task
        tokio::task::spawn_local(async move {
            if let Err(e) = io_task.await {
                tracing::error!("ACP I/O error: {}", e);
            }
        });

        Ok(Self {
            conn,
            _child: child,
            session_id: None,
        })
    }

    /// Initializes the ACP connection with the agent.
    pub async fn initialize(&self) -> Result<()> {
        self.conn
            .initialize(
                InitializeRequest::new(ProtocolVersion::LATEST)
                    .client_info(
                        Implementation::new("rawko", env!("CARGO_PKG_VERSION"))
                            .title("rawko"),
                    ),
            )
            .await
            .map_err(|e| Error::Protocol {
                message: format!("ACP initialization failed: {}", e),
            })?;

        Ok(())
    }

    /// Creates a new session with the agent.
    pub async fn new_session(&mut self, cwd: PathBuf) -> Result<SessionId> {
        let response = self
            .conn
            .new_session(NewSessionRequest::new(cwd))
            .await
            .map_err(|e| Error::Protocol {
                message: format!("Failed to create session: {}", e),
            })?;

        self.session_id = Some(response.session_id.clone());
        Ok(response.session_id)
    }

    /// Sends a prompt to the agent.
    ///
    /// The agent's response will be streamed through the output channel
    /// provided when spawning the connection.
    pub async fn prompt(&self, message: &str) -> Result<()> {
        let session_id = self.session_id.as_ref().ok_or_else(|| Error::Agent {
            message: "No active session".to_string(),
        })?;

        self.conn
            .prompt(PromptRequest::new(
                session_id.clone(),
                vec![message.to_string().into()],
            ))
            .await
            .map_err(|e| Error::Protocol {
                message: format!("Prompt failed: {}", e),
            })?;

        Ok(())
    }

    /// Cancels the current running prompt in the session.
    ///
    /// The agent will stop processing and return a cancelled response.
    pub async fn cancel(&self) -> Result<()> {
        let session_id = self.session_id.as_ref().ok_or_else(|| Error::Agent {
            message: "No active session to cancel".to_string(),
        })?;

        self.conn
            .cancel(CancelNotification::new(session_id.clone()))
            .await
            .map_err(|e| Error::Protocol {
                message: format!("Cancel notification failed: {}", e),
            })?;

        Ok(())
    }

    /// Shuts down the connection, cancelling any active session.
    ///
    /// This cancels any running prompt (best effort) and drops the connection.
    /// The child process is cleaned up automatically (kill_on_drop=true).
    pub async fn shutdown(mut self) -> Result<()> {
        // Cancel any active session (best effort)
        if self.session_id.is_some() {
            let _ = self.cancel().await;
        }
        self.session_id = None;
        // Child process cleaned up on drop (kill_on_drop=true)
        Ok(())
    }

    /// Returns the current session ID, if any.
    pub fn session_id(&self) -> Option<&SessionId> {
        self.session_id.as_ref()
    }
}

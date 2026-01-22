//! ACP (Agent Client Protocol) client implementation for rawko.
//!
//! This module provides the ACP client that orchestrates external agents.
//! Agents handle their own tools and LLM calls - rawko just spawns them,
//! sends prompts, and receives responses.

pub mod connection;
pub mod pool;

pub use connection::AgentConnection;
pub use pool::AgentPool;

use agent_client_protocol::{
    self as acp, ContentChunk, CreateTerminalRequest, CreateTerminalResponse, Error as AcpError,
    ExtNotification, ExtRequest, ExtResponse, KillTerminalCommandRequest,
    KillTerminalCommandResponse, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionRequest,
    RequestPermissionResponse, Result as AcpResult, SessionNotification, SessionUpdate,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use tokio::sync::mpsc;

/// Minimal ACP client implementation.
///
/// This client only handles session notifications (agent output).
/// All fs/terminal methods return `method_not_found` because agents
/// handle their own execution.
pub struct RawkoClient {
    /// Channel to send agent output for display.
    output_tx: mpsc::UnboundedSender<AgentOutput>,
}

/// Output from an agent during a session.
#[derive(Debug, Clone)]
pub enum AgentOutput {
    /// Text content from the agent.
    Text(String),
    /// Other content type (image, audio, resource).
    Other(String),
}

impl RawkoClient {
    /// Creates a new RawkoClient with an output channel.
    pub fn new(output_tx: mpsc::UnboundedSender<AgentOutput>) -> Self {
        Self { output_tx }
    }
}

#[async_trait::async_trait(?Send)]
impl acp::Client for RawkoClient {
    async fn request_permission(
        &self,
        _args: RequestPermissionRequest,
    ) -> AcpResult<RequestPermissionResponse> {
        // Agents handle their own permissions
        Err(AcpError::method_not_found())
    }

    async fn session_notification(&self, args: SessionNotification) -> AcpResult<()> {
        match args.update {
            SessionUpdate::AgentMessageChunk(ContentChunk { content, .. }) => {
                let text = match content {
                    acp::ContentBlock::Text(t) => t.text,
                    acp::ContentBlock::Image(_) => "[image]".to_string(),
                    acp::ContentBlock::Audio(_) => "[audio]".to_string(),
                    acp::ContentBlock::ResourceLink(r) => format!("[resource: {}]", r.uri),
                    acp::ContentBlock::Resource(_) => "[resource]".to_string(),
                    _ => "[unknown]".to_string(),
                };
                let _ = self.output_tx.send(AgentOutput::Text(text));
            }
            _ => {
                // Ignore other update types for now
            }
        }
        Ok(())
    }

    async fn write_text_file(&self, _args: WriteTextFileRequest) -> AcpResult<WriteTextFileResponse> {
        // Agents handle their own file operations
        Err(AcpError::method_not_found())
    }

    async fn read_text_file(&self, _args: ReadTextFileRequest) -> AcpResult<ReadTextFileResponse> {
        // Agents handle their own file operations
        Err(AcpError::method_not_found())
    }

    async fn create_terminal(&self, _args: CreateTerminalRequest) -> AcpResult<CreateTerminalResponse> {
        // Agents handle their own terminal operations
        Err(AcpError::method_not_found())
    }

    async fn terminal_output(&self, _args: TerminalOutputRequest) -> AcpResult<TerminalOutputResponse> {
        Err(AcpError::method_not_found())
    }

    async fn release_terminal(&self, _args: ReleaseTerminalRequest) -> AcpResult<ReleaseTerminalResponse> {
        Err(AcpError::method_not_found())
    }

    async fn wait_for_terminal_exit(&self, _args: WaitForTerminalExitRequest) -> AcpResult<WaitForTerminalExitResponse> {
        Err(AcpError::method_not_found())
    }

    async fn kill_terminal_command(&self, _args: KillTerminalCommandRequest) -> AcpResult<KillTerminalCommandResponse> {
        Err(AcpError::method_not_found())
    }

    async fn ext_method(&self, _args: ExtRequest) -> AcpResult<ExtResponse> {
        Err(AcpError::method_not_found())
    }

    async fn ext_notification(&self, _args: ExtNotification) -> AcpResult<()> {
        Ok(())
    }
}

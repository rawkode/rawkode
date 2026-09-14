use multipass_network::PeerSummary;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};
use uuid::Uuid;

pub const MAX_COMMAND_BYTES: usize = 8192;

#[derive(Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub command: Command,
}
#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    Status,
    SetSlot {
        slot: u8,
    },
    SetEnabled {
        enabled: bool,
    },
    /// Start pairing with a computer from `State::nearby`.
    Pair {
        peer: Uuid,
    },
    /// Answer the code prompt for the pairing in progress.
    ConfirmPairing {
        accept: bool,
    },
    /// Forget the pairing key.
    Unpair,
    Suspend,
    Resume,
    Shutdown,
}

/// A pairing in progress. `code` is absent while connecting.
#[derive(Clone, Serialize, PartialEq)]
pub struct PairingStatus {
    pub peer_name: String,
    pub code: Option<String>,
    pub incoming: bool,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct State {
    pub node_name: String,
    pub local_slot: u8,
    pub enabled: bool,
    pub paired: bool,
    pub keyboard_present: Option<bool>,
    pub mouse_present: Option<bool>,
    pub network_status: String,
    pub peers: usize,
    pub nearby: Vec<PeerSummary>,
    pub pairing: Option<PairingStatus>,
    pub last_event: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    State { state: State },
    Result { id: u64, ok: bool, message: String },
}

/// Read a bounded line without first allocating attacker-controlled input length.
pub fn read_command_line(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut result = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if result.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Incomplete command",
                ))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if result.len() + count > MAX_COMMAND_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Command exceeds size limit",
            ));
        }
        result.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(result));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_are_framed_and_bounded() {
        let mut reader = io::Cursor::new(
            b"{\"id\":1,\"command\":\"status\"}\n{\"id\":2,\"command\":\"shutdown\"}\n",
        );
        let request: Request =
            serde_json::from_slice(&read_command_line(&mut reader).unwrap().unwrap()).unwrap();
        assert!(matches!(request.command, Command::Status));
        assert!(read_command_line(&mut reader).unwrap().is_some());
        assert!(read_command_line(&mut reader).unwrap().is_none());
        assert!(
            read_command_line(&mut io::Cursor::new(vec![b'a'; MAX_COMMAND_BYTES + 1])).is_err()
        );
        assert!(read_command_line(&mut io::Cursor::new(b"partial")).is_err());
    }
    #[test]
    fn unknown_commands_and_missing_fields_are_rejected() {
        for input in [
            r#"{"id":1,"command":"execute","program":"sh"}"#,
            r#"{"id":1,"command":"set_enabled"}"#,
            r#"{"id":1,"command":"create_pairing"}"#,
            r#"{"id":1,"command":"join_pairing","code":"x"}"#,
            r#"{"id":1,"command":"pair","peer":"not-a-uuid"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(input).is_err());
        }
        let request: Request = serde_json::from_str(
            r#"{"id":3,"command":"pair","peer":"0b7a9d3e-6f4c-4a2b-9c1d-2e3f4a5b6c7d"}"#,
        )
        .unwrap();
        assert!(matches!(request.command, Command::Pair { .. }));
    }
}

//! Real child-process checks use a disposable config directory and never enable hardware switching.
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn start(directory: &std::path::Path) -> std::process::Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_multipass-engine"));
    command
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.env("MULTIPASS_CONFIG_DIR", directory);
    command.spawn().unwrap()
}
fn wait_bounded(child: &mut std::process::Child) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill().unwrap();
    panic!("Engine failed to exit after stdin closed");
}
#[test]
fn closing_stdin_stops_the_engine() {
    let directory = tempfile::tempdir().unwrap();
    let mut child = start(directory.path());
    drop(child.stdin.take());
    wait_bounded(&mut child);
}
#[test]
fn shutdown_is_framed_and_stops_without_waiting_for_stdin_eof() {
    let directory = tempfile::tempdir().unwrap();
    let mut child = start(directory.path());
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(b"{\"id\":9,\"command\":\"shutdown\"}\n")
        .unwrap();
    stdin.flush().unwrap();
    wait_bounded(&mut child);
    let output: Vec<_> = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(output
        .iter()
        .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()));
    assert!(
        output.iter().any(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            value["type"] == "result" && value["id"] == 9 && value["ok"] == true
        }),
        "Shutdown must be acknowledged, not merely exit after startup failure"
    );
}

use multipass_core::{
    config::ConfigStore,
    engine::Engine,
    ipc::{self, Event, Request},
};
use std::io::{self, Write};
use tokio::sync::mpsc;

#[tokio::main(worker_threads = 2)]
async fn main() {
    let mode = std::env::args().nth(1);
    if mode.as_deref() == Some("--probe") {
        match multipass_hardware::probe() {
            Ok(info) => println!(
                "Mouse supports {} slots; current slot {}",
                info.host_count, info.current_slot
            ),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if mode.as_deref() == Some("--keyboard-identities") {
        match multipass_hardware::connected_keyboard_addresses() {
            Ok(addresses) => {
                for address in addresses {
                    let octets = address.map(|octet| format!("{octet:02x}"));
                    println!("{}", octets.join(":"));
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if mode.as_deref() == Some("--link-keyboard") {
        let result = (|| -> anyhow::Result<()> {
            let config = ConfigStore::system()?;
            let mut settings = config.load()?;
            settings.link_keyboard(&std::env::args().skip(2).collect::<Vec<_>>())?;
            config.save(&settings)
        })();
        if let Err(error) = result {
            eprintln!("{error:#}");
            std::process::exit(1);
        }
        println!("Linked keyboard addresses");
        return;
    }
    if mode.as_deref() != Some("--stdio") {
        eprintln!("Usage: multipass-engine --stdio | --probe | --keyboard-identities | --link-keyboard ADDRESS ADDRESS [ADDRESS]");
        std::process::exit(2);
    }
    let (sender, receiver) = mpsc::channel::<Request>(32);
    // A dedicated OS thread avoids an uncancellable Tokio stdin task delaying engine shutdown.
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();
        while let Ok(Some(line)) = ipc::read_command_line(&mut reader) {
            let request = match serde_json::from_slice(&line) {
                Ok(request) => request,
                Err(_) => {
                    write_event(Event::Result {
                        id: 0,
                        ok: false,
                        message: "Invalid command".into(),
                    });
                    continue;
                }
            };
            if sender.blocking_send(request).is_err() {
                break;
            }
        }
        // EOF/malformed framing drops the command sender; the engine stops and cancels requests.
    });
    match Engine::new().await {
        Ok(engine) => engine.run(receiver, write_event).await,
        Err(error) => {
            write_event(Event::Result {
                id: 0,
                ok: false,
                message: format!("Cannot start Multipass: {error}"),
            });
            std::process::exit(1);
        }
    }
}

fn write_event(event: Event) {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if serde_json::to_writer(&mut output, &event).is_err()
        || output.write_all(b"\n").is_err()
        || output.flush().is_err()
    {
        // Do not exit here: reader EOF is the normal cleanup path. The parent should close both pipes.
    }
}

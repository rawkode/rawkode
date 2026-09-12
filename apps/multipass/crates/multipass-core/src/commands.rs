use crate::{
    config,
    engine::Engine,
    ipc::{Command, Event, Request},
};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;

impl Engine {
    pub(crate) async fn command(&mut self, request: Request) -> Event {
        let result = self.apply(request.command).await;
        match result {
            Ok((message, code)) => Event::Result {
                id: request.id,
                ok: true,
                message,
                pairing_code: code,
            },
            Err(error) => Event::Result {
                id: request.id,
                ok: false,
                message: error.to_string(),
                pairing_code: None,
            },
        }
    }

    async fn apply(&mut self, command: Command) -> Result<(String, Option<String>)> {
        match command {
            Command::Status => Ok((self.state.network_status.clone(), None)),
            Command::SetSlot { slot } => {
                if !(1..=3).contains(&slot) {
                    bail!("Mouse slot must be 1, 2, or 3");
                }
                let mut settings = self.settings.clone();
                settings.local_slot = slot;
                self.config.save(&settings)?;
                self.settings = settings;
                self.state.local_slot = slot;
                self.reset();
                self.state.last_event =
                    "Slot changed; waiting for a fresh keyboard connection".into();
                Ok((self.state.last_event.clone(), None))
            }
            Command::SetEnabled { enabled } => {
                if !enabled {
                    self.state.enabled = false;
                    self.settings.enabled = false;
                    self.stop_network().await;
                    self.state.network_status = "Automatic switching paused".into();
                    self.config.save(&self.settings).map_err(|error| {
                        anyhow::anyhow!(
                            "Switching is paused, but the preference could not be saved: {error}"
                        )
                    })?;
                    return Ok((self.state.network_status.clone(), None));
                }
                if enabled && self.secret.is_none() {
                    bail!("Pair your computers before enabling switching");
                }
                let mut settings = self.settings.clone();
                settings.enabled = enabled;
                self.config.save(&settings)?;
                self.settings = settings;
                self.state.enabled = enabled;
                self.stop_network().await;
                if enabled {
                    if let Err(error) = self.start_network().await {
                        self.state.enabled = false;
                        self.settings.enabled = false;
                        let _ = self.config.save(&self.settings);
                        self.state.network_status = format!("Cannot start discovery: {error}");
                        return Err(error);
                    }
                } else {
                    self.state.network_status = "Automatic switching paused".into();
                }
                Ok((self.state.network_status.clone(), None))
            }
            Command::CreatePairing => {
                let mut secret = [0; 32];
                rand::rngs::OsRng.fill_bytes(&mut secret);
                self.install_secret(secret).await?;
                Ok((
                    "Enter this code on your other computer; keep it private".into(),
                    Some(STANDARD.encode(secret)),
                ))
            }
            Command::JoinPairing { code } => {
                let secret = config::parse_code(&code)?;
                self.install_secret(secret).await?;
                Ok((
                    "Pairing key saved; enable automatic switching on both computers".into(),
                    None,
                ))
            }
            Command::Suspend => {
                self.suspend().await;
                Ok(("Suspended".into(), None))
            }
            Command::Resume => {
                self.resume().await?;
                Ok(("Waiting for a fresh keyboard connection".into(), None))
            }
            Command::Shutdown => {
                self.stop_network().await;
                Ok(("Stopped".into(), None))
            }
        }
    }

    async fn install_secret(&mut self, secret: [u8; 32]) -> Result<()> {
        // Persist disabled before replacing a credential, so a partial failure cannot re-arm it.
        let mut settings = self.settings.clone();
        settings.enabled = false;
        self.config.save(&settings)?;
        self.settings = settings;
        self.state.enabled = false;
        self.stop_network().await;
        self.state.network_status = "Automatic switching paused".into();
        config::save_secret(&secret)?;
        self.secret = Some(secret);
        self.state.paired = true;
        Ok(())
    }
}

use crate::{
    config,
    engine::Engine,
    ipc::{Command, Event, Request},
};
use anyhow::{bail, Context as _, Result};

impl Engine {
    pub(crate) async fn command(&mut self, request: Request) -> Event {
        match self.apply(request.command).await {
            Ok(message) => Event::Result {
                id: request.id,
                ok: true,
                message,
            },
            Err(error) => Event::Result {
                id: request.id,
                ok: false,
                message: error.to_string(),
            },
        }
    }

    async fn apply(&mut self, command: Command) -> Result<String> {
        match command {
            Command::Status => Ok(self.state.network_status.clone()),
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
                Ok(self.state.last_event.clone())
            }
            Command::SetEnabled { enabled } => {
                if !enabled {
                    self.state.enabled = false;
                    self.settings.enabled = false;
                    self.reset();
                    self.config.save(&self.settings).map_err(|error| {
                        anyhow::anyhow!(
                            "Switching is paused, but the preference could not be saved: {error}"
                        )
                    })?;
                    return Ok("Automatic switching paused".into());
                }
                if self.secret.is_none() {
                    bail!("Pair your computers before enabling switching");
                }
                let mut settings = self.settings.clone();
                settings.enabled = true;
                self.config.save(&settings)?;
                self.settings = settings;
                self.state.enabled = true;
                self.reset();
                if self.network.is_none() {
                    if let Err(error) = self.start_network().await {
                        self.state.enabled = false;
                        self.settings.enabled = false;
                        let _ = self.config.save(&self.settings);
                        self.state.network_status = format!("Cannot start discovery: {error}");
                        return Err(error);
                    }
                }
                if let Some(warning) = self.check_mouse_access().await {
                    return Ok(warning);
                }
                Ok("Automatic switching on; wait three seconds before testing".into())
            }
            Command::Pair { peer } => {
                if self.state.pairing.is_some() {
                    bail!("Finish the pairing already in progress first");
                }
                let name = self
                    .state
                    .nearby
                    .iter()
                    .find(|summary| summary.id == peer)
                    .map(|summary| summary.name.clone())
                    .context("That computer is no longer visible on the network")?;
                self.network
                    .as_ref()
                    .context("Discovery is not running")?
                    .pair(peer)?;
                Ok(format!("Connecting to {name}"))
            }
            Command::ConfirmPairing { accept } => {
                let answered = self
                    .network
                    .as_ref()
                    .is_some_and(|network| network.decide(accept));
                if !answered {
                    self.state.pairing = None;
                    bail!("No pairing is waiting for an answer");
                }
                Ok(if accept {
                    "Waiting for the other computer to confirm".into()
                } else {
                    "Pairing cancelled".into()
                })
            }
            Command::Unpair => {
                self.disable_switching()?;
                config::delete_secret()?;
                self.secret = None;
                self.state.paired = false;
                if let Some(network) = &self.network {
                    network.set_secret(None);
                }
                self.state.last_event = "Pairing forgotten".into();
                Ok(self.state.last_event.clone())
            }
            Command::Suspend => {
                self.suspend().await;
                Ok("Suspended".into())
            }
            Command::Resume => {
                self.resume().await?;
                Ok("Waiting for a fresh keyboard connection".into())
            }
            Command::Shutdown => {
                self.stop_network().await;
                Ok("Stopped".into())
            }
        }
    }

    /// Persist switching off before any credential change, so a partial failure cannot re-arm it.
    fn disable_switching(&mut self) -> Result<()> {
        let mut settings = self.settings.clone();
        settings.enabled = false;
        self.config.save(&settings)?;
        self.settings = settings;
        self.state.enabled = false;
        self.reset();
        Ok(())
    }

    pub(crate) fn install_secret(&mut self, secret: [u8; 32]) -> Result<()> {
        self.disable_switching()?;
        config::save_secret(&secret)?;
        self.secret = Some(secret);
        self.state.paired = true;
        if let Some(network) = &self.network {
            network.set_secret(Some(secret));
        }
        Ok(())
    }
}

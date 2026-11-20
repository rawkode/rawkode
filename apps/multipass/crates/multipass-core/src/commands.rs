use crate::{
    config,
    engine::Engine,
    ipc::{Command, Event, Request},
};
use anyhow::{bail, Context as _, Result};
use multipass_network::PeerSummary;

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
                settings.slot_confirmed = true;
                self.config.save(&settings)?;
                self.settings = settings;
                self.state.local_slot = slot;
                self.state.slot_confirmed = true;
                self.reset();
                self.state.last_event = format!("Mouse slot {slot} confirmed for this computer.");
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
                if !self.state.slot_confirmed {
                    bail!("Confirm the mouse’s Bluetooth slot for this computer before enabling switching");
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
            Command::Pair { peer, replace } => {
                if let Some(error) = &self.state.credential_error {
                    bail!("{error}");
                }
                if self.state.pairing.is_some() {
                    bail!("Finish the pairing already in progress first");
                }
                if self.state.paired && !replace {
                    bail!("Confirm that you want to replace the current pairing first");
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
                if accept {
                    if let Some(error) = &self.state.credential_error {
                        bail!("{error}");
                    }
                }
                let pairing = self
                    .state
                    .pairing
                    .as_mut()
                    .context("No pairing is waiting for an answer")?;
                if pairing.locally_confirmed {
                    bail!("Already confirmed here. Waiting for {}.", pairing.peer_name);
                }
                if accept && pairing.code.is_none() {
                    bail!("Wait for the code on both computers before confirming");
                }
                let answered = self
                    .network
                    .as_ref()
                    .is_some_and(|network| network.decide(accept));
                if !answered {
                    self.state.pairing = None;
                    bail!("No pairing is waiting for an answer");
                }
                Ok(if accept {
                    pairing.locally_confirmed = true;
                    format!("Confirmed here. Waiting for {}.", pairing.peer_name)
                } else {
                    "Pairing cancelled".into()
                })
            }
            Command::Unpair => {
                self.prepare_credential_change()?;
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
    fn prepare_credential_change(&mut self) -> Result<()> {
        let mut settings = self.settings.clone();
        settings.enabled = false;
        settings.paired_peer = None;
        self.config.save(&settings)?;
        self.settings = settings;
        self.state.enabled = false;
        self.state.paired_peer = None;
        self.reset();
        Ok(())
    }

    pub(crate) fn install_secret(
        &mut self,
        secret: [u8; 32],
        peer: PeerSummary,
    ) -> Result<Option<String>> {
        self.prepare_credential_change()?;
        config::save_secret(&secret)?;
        self.secret = Some(secret);
        self.state.paired = true;
        if let Some(network) = &self.network {
            network.set_secret(Some(secret));
        }
        let mut settings = self.settings.clone();
        settings.paired_peer = Some(peer.clone());
        if let Err(error) = self.config.save(&settings) {
            return Ok(Some(format!(
                "Paired with {}, but its name could not be saved: {error}.",
                peer.name
            )));
        }
        self.settings = settings;
        self.state.paired_peer = Some(peer);
        Ok(None)
    }
}

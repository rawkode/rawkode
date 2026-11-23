use anyhow::{bail, Context, Result};
use directories::ProjectDirs;
use multipass_network::PeerSummary;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u8,
    pub node_id: Uuid,
    pub local_slot: u8,
    #[serde(default = "legacy_slot_confirmed")]
    pub slot_confirmed: bool,
    #[serde(default)]
    pub paired_peer: Option<PeerSummary>,
    pub enabled: bool,
    #[serde(default)]
    pub keyboard_links: Vec<Vec<[u8; 6]>>,
}
impl Settings {
    pub fn link_keyboard(&mut self, addresses: &[String]) -> Result<()> {
        let mut link = addresses
            .iter()
            .map(|text| {
                multipass_hardware::parse_bluetooth_address(text)
                    .with_context(|| format!("Invalid Bluetooth address: {text}"))
            })
            .collect::<Result<Vec<_>>>()?;
        link.sort_unstable();
        link.dedup();
        if !(2..=3).contains(&link.len()) {
            bail!("Provide two or three distinct Bluetooth addresses for one keyboard");
        }
        let mut existing = self
            .keyboard_links
            .iter_mut()
            .filter(|group| group.iter().any(|address| link.contains(address)));
        if let Some(group) = existing.next() {
            if existing.next().is_some() || group.iter().any(|address| !link.contains(address)) {
                bail!("Provide all addresses from the existing keyboard link");
            }
            *group = link;
        } else {
            self.keyboard_links.push(link);
        }
        Ok(())
    }

    pub(crate) fn keyboard_matches(
        &self,
        local: [u8; 6],
        nonce: &[u8; 32],
        secret: &[u8; 32],
        key: &[u8; 32],
    ) -> bool {
        let matches = |address| multipass_network::keyboard_key(address, nonce, secret) == *key;
        matches(local)
            || slot_siblings(local).any(matches)
            || self
                .keyboard_links
                .iter()
                .any(|group| group.contains(&local) && group.iter().copied().any(matches))
    }
}

/// Multi-host keyboards commonly present one Bluetooth address per host slot, differing
/// only in the final byte (for example `…:A0` on slot 1 and `…:A1` on slot 2). Requests
/// carry a keyed hash rather than the address, so the receiver tries each nearby final
/// byte. Departures are still required here, so a sibling can only match a keyboard that
/// actually left this computer; keyboards with unrelated per-slot addresses need a link.
const SLOT_ADDRESS_SPREAD: u8 = 2;

fn slot_siblings(address: [u8; 6]) -> impl Iterator<Item = [u8; 6]> {
    (1..=SLOT_ADDRESS_SPREAD).flat_map(move |offset| {
        [
            address[5].checked_sub(offset),
            address[5].checked_add(offset),
        ]
        .into_iter()
        .flatten()
        .map(move |last| {
            let mut sibling = address;
            sibling[5] = last;
            sibling
        })
    })
}

// Existing installations already use their saved slot for switching.
fn legacy_slot_confirmed() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            node_id: Uuid::new_v4(),
            local_slot: 1,
            slot_confirmed: false,
            paired_peer: None,
            enabled: false,
            keyboard_links: Vec::new(),
        }
    }
}

pub struct ConfigStore {
    directory: PathBuf,
    _lock: Option<fs::File>,
}
impl ConfigStore {
    pub fn system() -> Result<Self> {
        let dirs = ProjectDirs::from("dev", "rawkode", "Multipass")
            .context("Cannot locate this user's configuration directory")?;
        let directory = std::env::var_os("MULTIPASS_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs.config_dir().to_owned());
        fs::create_dir_all(&directory)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("engine.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .context("Multipass is already running for this user")?;
        Ok(Self {
            directory,
            _lock: Some(lock),
        })
    }
    pub fn load(&self) -> Result<Settings> {
        let bytes = match fs::read(self.directory.join("settings.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Settings::default())
            }
            Err(error) => return Err(error).context("Cannot read Multipass settings"),
        };
        let settings: Settings =
            serde_json::from_slice(&bytes).context("Invalid Multipass settings")?;
        if settings.version != 1 || !(1..=3).contains(&settings.local_slot) {
            bail!("Unsupported settings version or invalid mouse slot");
        }
        Ok(settings)
    }
    pub fn save(&self, settings: &Settings) -> Result<()> {
        fs::create_dir_all(&self.directory).context("Cannot create configuration directory")?;
        let temporary = self.directory.join("settings.json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(settings)?)?;
        fs::rename(temporary, self.directory.join("settings.json"))
            .context("Cannot save Multipass settings")
    }
}

/// The credential-store account for this engine's pairing key. An engine run
/// with `MULTIPASS_CONFIG_DIR` (tests, side-by-side instances) gets its own
/// account so it never touches, or prompts for, the real installation's key.
fn secret_account() -> String {
    match std::env::var_os("MULTIPASS_CONFIG_DIR") {
        Some(directory) => format!("peer-secret-v1:{}", directory.to_string_lossy()),
        None => "peer-secret-v1".into(),
    }
}

pub fn load_secret() -> Result<Option<[u8; 32]>> {
    let entry = keyring::Entry::new("dev.rawkode.multipass", &secret_account())?;
    match entry.get_secret() {
        Ok(data) => data
            .try_into()
            .map(Some)
            .map_err(|_| anyhow::anyhow!("Stored pairing key has an invalid length")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => {
            Err(error).context("Cannot access OS credential store; unlock it before pairing")
        }
    }
}

pub fn save_secret(secret: &[u8; 32]) -> Result<()> {
    keyring::Entry::new("dev.rawkode.multipass", &secret_account())?
        .set_secret(secret)
        .context("Cannot save pairing key in OS credential store")
}

pub fn delete_secret() -> Result<()> {
    match keyring::Entry::new("dev.rawkode.multipass", &secret_account())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Cannot remove pairing key from OS credential store"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linked_addresses_match_in_both_directions_only_for_the_configured_keyboard() {
        let mut settings = Settings::default();
        let first = [1, 2, 3, 4, 5, 6];
        let second = [9, 8, 7, 6, 5, 4];
        let unrelated = [1, 2, 3, 4, 6, 6];
        let nonce = [3; 32];
        let secret = [4; 32];
        let first_key = multipass_network::keyboard_key(first, &nonce, &secret);
        let second_key = multipass_network::keyboard_key(second, &nonce, &secret);
        assert!(settings.keyboard_matches(first, &nonce, &secret, &first_key));
        assert!(!settings.keyboard_matches(first, &nonce, &secret, &second_key));

        let addresses = ["01:02:03:04:05:06".into(), "09-08-07-06-05-04".into()];
        settings.link_keyboard(&addresses).unwrap();
        settings.link_keyboard(&addresses).unwrap();
        assert_eq!(settings.keyboard_links.len(), 1);
        assert!(settings.keyboard_matches(first, &nonce, &secret, &second_key));
        assert!(settings.keyboard_matches(second, &nonce, &secret, &first_key));
        assert!(!settings.keyboard_matches(unrelated, &nonce, &secret, &first_key));
    }

    #[test]
    fn per_slot_addresses_differing_in_the_final_byte_match_without_a_link() {
        let settings = Settings::default();
        let nonce = [3; 32];
        let secret = [4; 32];
        let key = |address| multipass_network::keyboard_key(address, &nonce, &secret);
        let slot_one = [0xCA, 0xFE, 0x39, 0xE6, 0xC0, 0xA0];
        for remote in [
            [0xCA, 0xFE, 0x39, 0xE6, 0xC0, 0xA1],
            [0xCA, 0xFE, 0x39, 0xE6, 0xC0, 0xA2],
        ] {
            assert!(settings.keyboard_matches(slot_one, &nonce, &secret, &key(remote)));
            assert!(settings.keyboard_matches(remote, &nonce, &secret, &key(slot_one)));
        }
        for unrelated in [
            [0xCA, 0xFE, 0x39, 0xE6, 0xC0, 0xA3],
            [0xCA, 0xFE, 0x39, 0xE6, 0xC1, 0xA0],
        ] {
            assert!(!settings.keyboard_matches(slot_one, &nonce, &secret, &key(unrelated)));
        }
        let edge = [0, 0, 0, 0, 0, 0xFF];
        assert!(settings.keyboard_matches(edge, &nonce, &secret, &key([0, 0, 0, 0, 0, 0xFE])));
    }

    #[test]
    fn existing_settings_keep_their_mouse_slot_without_requiring_setup() {
        let old = serde_json::json!({"version": 1, "node_id": Uuid::new_v4(), "local_slot": 2, "enabled": true});
        let settings: Settings = serde_json::from_value(old).unwrap();
        assert!(settings.slot_confirmed && settings.enabled);
        assert_eq!(settings.local_slot, 2);
        assert!(settings.paired_peer.is_none());
    }
    #[test]
    fn settings_round_trip_and_corruption_is_not_a_default() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore {
            directory: directory.path().to_owned(),
            _lock: None,
        };
        let mut settings = store.load().unwrap();
        assert!(!settings.slot_confirmed);
        settings.local_slot = 2;
        settings.slot_confirmed = true;
        store.save(&settings).unwrap();
        assert_eq!(store.load().unwrap().node_id, settings.node_id);
        assert_eq!(store.load().unwrap().local_slot, 2);
        fs::write(directory.path().join("settings.json"), b"broken").unwrap();
        assert!(store.load().is_err());
    }
}

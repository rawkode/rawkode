use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u8,
    pub node_id: Uuid,
    pub local_slot: u8,
    pub enabled: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            node_id: Uuid::new_v4(),
            local_slot: 1,
            enabled: false,
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

pub fn load_secret() -> Result<Option<[u8; 32]>> {
    let entry = keyring::Entry::new("dev.rawkode.multipass", "peer-secret-v1")?;
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
    keyring::Entry::new("dev.rawkode.multipass", "peer-secret-v1")?
        .set_secret(secret)
        .context("Cannot save pairing key in OS credential store")
}

pub fn parse_code(code: &str) -> Result<[u8; 32]> {
    STANDARD
        .decode(code.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .context("Paste the complete pairing code from the other computer")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_round_trip_and_corruption_is_not_a_default() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore {
            directory: directory.path().to_owned(),
            _lock: None,
        };
        let mut settings = store.load().unwrap();
        settings.local_slot = 2;
        store.save(&settings).unwrap();
        assert_eq!(store.load().unwrap().node_id, settings.node_id);
        assert_eq!(store.load().unwrap().local_slot, 2);
        fs::write(directory.path().join("settings.json"), b"broken").unwrap();
        assert!(store.load().is_err());
    }
    #[test]
    fn invalid_pairing_codes_rejected_without_echoing_secret() {
        assert!(parse_code("not-a-key").is_err());
        assert!(parse_code(&STANDARD.encode([1; 31])).is_err());
        assert_eq!(parse_code(&STANDARD.encode([7; 32])).unwrap(), [7; 32]);
    }
}

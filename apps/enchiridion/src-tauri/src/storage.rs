use loro::{LoroDoc, LoroValue};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDay {
    pub day: String,
    pub token: String,
    pub revision: u64,
    pub sequence: u64,
    pub dirty: bool,
    pub snapshot: Option<Vec<u8>>,
    pub legacy: Option<Vec<u8>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub day: String,
    pub token: String,
    pub sequence: u64,
    pub base_revision: u64,
    pub snapshot: Vec<u8>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SaveReceipt {
    pub revision: u64,
    pub sequence: u64,
}

struct Lease {
    day: String,
    token: String,
    revision: u64,
    sequence: u64,
    acknowledged_sequence: u64,
    saved: Option<Vec<u8>>,
    pending: Option<Vec<u8>>,
    legacy: Option<Vec<u8>>,
}

pub struct NoteStore {
    directory: PathBuf,
    legacy_directory: Option<PathBuf>,
    lease: Option<Lease>,
}

impl NoteStore {
    pub fn new(directory: PathBuf, legacy_directory: Option<PathBuf>) -> Self {
        Self {
            directory,
            legacy_directory,
            lease: None,
        }
    }

    pub fn load_day(&mut self, day: &str) -> Result<LoadedDay, String> {
        validate_day(day)?;
        if let Some(lease) = &self.lease {
            if lease.day == day {
                return Ok(Self::loaded(lease));
            }
            if lease.pending.is_some() {
                return Err(
                    "The current note has unsaved changes. Retry saving before changing days."
                        .into(),
                );
            }
        }
        let snapshot = read_optional(&self.directory.join(format!("{day}.loro")))?;
        let legacy = if snapshot.is_none() {
            match &self.legacy_directory {
                Some(directory) => read_optional(&directory.join(format!("{day}.loro")))?,
                None => None,
            }
        } else {
            None
        };
        if let Some(bytes) = &snapshot {
            validate_snapshot(bytes, day, false)?;
        }
        if let Some(bytes) = &legacy {
            validate_snapshot(bytes, day, true)?;
        }
        let lease = Lease {
            day: day.into(),
            token: Uuid::new_v4().to_string(),
            revision: 0,
            sequence: 0,
            acknowledged_sequence: 0,
            saved: snapshot,
            pending: None,
            legacy,
        };
        let result = Self::loaded(&lease);
        self.lease = Some(lease);
        Ok(result)
    }

    fn loaded(lease: &Lease) -> LoadedDay {
        LoadedDay {
            day: lease.day.clone(),
            token: lease.token.clone(),
            revision: lease.revision,
            sequence: lease.sequence,
            dirty: lease.pending.is_some(),
            snapshot: lease.pending.as_ref().or(lease.saved.as_ref()).cloned(),
            legacy: if lease.saved.is_none() && lease.pending.is_none() {
                lease.legacy.clone()
            } else {
                None
            },
        }
    }

    pub fn save_day(&mut self, request: SaveRequest) -> Result<SaveReceipt, String> {
        self.save_using(request, atomic_write)
    }

    fn save_using(
        &mut self,
        request: SaveRequest,
        write: impl Fn(&Path, &[u8]) -> Result<(), String>,
    ) -> Result<SaveReceipt, String> {
        validate_day(&request.day)?;
        let lease = self.lease.as_mut().ok_or("Open a day before saving.")?;
        if request.token != lease.token || request.day != lease.day {
            return Err("This save belongs to an editor that is no longer active.".into());
        }
        if request.sequence == 0 || request.sequence > MAX_SAFE_INTEGER {
            return Err("Invalid save sequence.".into());
        }
        // An acknowledgement may have been lost after a successful write.
        if lease.pending.is_none()
            && request.sequence == lease.acknowledged_sequence
            && lease.saved.as_ref() == Some(&request.snapshot)
        {
            return Ok(SaveReceipt {
                revision: lease.revision,
                sequence: request.sequence,
            });
        }
        if request.base_revision != lease.revision || request.sequence < lease.sequence {
            return Err("This save is stale. The newer note has been preserved.".into());
        }
        if request.sequence == lease.sequence && lease.pending.as_ref() != Some(&request.snapshot) {
            return Err("A save sequence cannot be reused for different content.".into());
        }
        validate_snapshot(&request.snapshot, &request.day, false)?;
        lease.sequence = request.sequence;
        lease.pending = Some(request.snapshot);
        // Keep legacy bytes intact, including if the subsequent authoritative write fails.
        if let Some(legacy) = &lease.legacy {
            let backup = self.directory.join(format!("{}.legacy.loro", lease.day));
            match read_optional(&backup)? {
                Some(existing) if existing != *legacy => return Err(
                    "The migration backup differs from the original. Neither file was overwritten."
                        .into(),
                ),
                Some(_) => {}
                None => write(&backup, legacy)?,
            }
        }
        let pending = lease
            .pending
            .as_ref()
            .expect("pending snapshot established above");
        write(&self.directory.join(format!("{}.loro", lease.day)), pending)?;
        lease.saved = lease.pending.take();
        lease.acknowledged_sequence = lease.sequence;
        lease.revision += 1;
        Ok(SaveReceipt {
            revision: lease.revision,
            sequence: lease.sequence,
        })
    }

    pub fn can_finish_quit(&self, token: Option<&str>, sequence: u64) -> Result<(), String> {
        match &self.lease {
            None if token.is_none() && sequence == 0 => Ok(()),
            Some(lease)
                if token == Some(lease.token.as_str())
                    && lease.pending.is_none()
                    && sequence == lease.acknowledged_sequence =>
            {
                Ok(())
            }
            _ => Err("The current editor must finish saving before quitting.".into()),
        }
    }
}

pub fn validate_day(day: &str) -> Result<(), String> {
    let bytes = day.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return Err("Use a Gregorian date in YYYY-MM-DD format.".into());
    }
    let year: u32 = day[..4].parse().map_err(|_| "Invalid year.")?;
    let month: usize = day[5..7].parse().map_err(|_| "Invalid month.")?;
    let date: u32 = day[8..].parse().map_err(|_| "Invalid day.")?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if year == 0 || !(1..=12).contains(&month) || date == 0 || date > days[month - 1] {
        return Err("That Gregorian date does not exist.".into());
    }
    Ok(())
}

fn validate_snapshot(bytes: &[u8], day: &str, legacy: bool) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("Invalid or oversized note snapshot.".into());
    }
    let doc = LoroDoc::new();
    doc.import(bytes)
        .map_err(|_| "This note is not a valid Loro snapshot. Its file was preserved.")?;
    let LoroValue::Map(metadata) = doc.get_map("metadata").get_value() else {
        return Err("Missing note metadata.".into());
    };
    let expected_day = LoroValue::String(day.into());
    if metadata.get("day") != Some(&expected_day) {
        return Err("The snapshot belongs to a different day.".into());
    }
    let version = metadata.get("schemaVersion");
    let allowed = if legacy {
        version == Some(&LoroValue::I64(1)) || version == Some(&LoroValue::I64(2))
    } else {
        version == Some(&LoroValue::I64(3))
    };
    if !allowed {
        return Err(
            "This note uses an unsupported document schema. Its file was preserved.".into(),
        );
    }
    if !legacy {
        if metadata.get("binding") != Some(&LoroValue::String("loro-prosemirror".into()))
            || metadata.get("bindingVersion") != Some(&LoroValue::String("0.4.4".into()))
            || metadata.get("editorSchema") != Some(&LoroValue::I64(1))
        {
            return Err("This note uses an unsupported editor binding.".into());
        }
        let LoroValue::Map(roots) = doc.get_value() else {
            return Err("Invalid document roots.".into());
        };
        if roots.len() != 2 || !roots.contains_key("doc") || !roots.contains_key("metadata") {
            return Err("Unexpected document roots. The original was preserved.".into());
        }
        let LoroValue::Map(root) = doc.get_map("doc").get_value() else {
            return Err("Invalid editor root.".into());
        };
        if root.get("nodeName") != Some(&LoroValue::String("doc".into())) {
            return Err("The snapshot has no ProseMirror document.".into());
        }
    }
    Ok(())
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the note: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
        return Err("The note is not a regular supported-size file.".into());
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("Could not read the note: {error}"))
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid destination.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the note directory: {error}"))?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Changes are not saved: {error}"))
}

#[cfg(test)]
mod tests;

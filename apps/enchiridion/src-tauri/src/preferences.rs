use crate::storage::atomic_write;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub display_name: String,
    pub show_menu_bar_item: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            display_name: default_display_name(),
            show_menu_bar_item: true,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => {
                if bytes.len() > 4096 {
                    return Err("The settings file is too large.".into());
                }
                let settings: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| "The settings file could not be read. It has been preserved.")?;
                settings.validate()?;
                Ok(settings)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("Could not read settings: {error}")),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        atomic_write(
            path,
            &serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?,
        )
    }

    fn validate(&self) -> Result<(), String> {
        if self.display_name.chars().count() > 200
            || self.display_name.chars().any(char::is_control)
        {
            return Err("Use a name of at most 200 characters without control characters.".into());
        }
        Ok(())
    }
}

fn preview_path(directory: &Path, key: &str) -> Result<PathBuf, String> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid preview key.".into());
    }
    Ok(directory.join(format!("{key}.png")))
}

fn validate_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 24
        || bytes.len() > 6 * 1024 * 1024
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        return Err("Invalid PNG preview.".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if !(1..=1600).contains(&width) || !(1..=1600).contains(&height) {
        return Err("Preview dimensions exceed 1600 pixels.".into());
    }
    tauri::image::Image::from_bytes(bytes).map_err(|_| "The preview cannot be decoded.")?;
    Ok(())
}

pub fn load_preview(directory: &Path, key: &str) -> Result<Option<String>, String> {
    let path = preview_path(directory, key)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.is_file() || metadata.len() > 6 * 1024 * 1024 => return Ok(None),
        Ok(_) => {}
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if validate_png(&bytes).is_err() {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes)
    )))
}

pub fn save_preview(directory: &Path, key: &str, data_url: &str) -> Result<(), String> {
    let path = preview_path(directory, key)?;
    if data_url.len() > 8 * 1024 * 1024 {
        return Err("The preview is too large.".into());
    }
    let data = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("Only PNG previews are supported.")?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid preview encoding.")?;
    validate_png(&bytes)?;
    atomic_write(&path, &bytes)
}

fn default_display_name() -> String {
    #[cfg(target_os = "macos")]
    {
        objc2_foundation::NSFullUserName().to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_preserve_corruption_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings {
            display_name: "David 📝".into(),
            show_menu_bar_item: false,
        };
        settings.save(&path).unwrap();
        assert_eq!(
            Settings::load(&path).unwrap().display_name,
            settings.display_name
        );
        fs::write(&path, b"broken").unwrap();
        assert!(Settings::load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
    }
    #[test]
    fn preview_cache_validates_paths_and_png() {
        let dir = tempfile::tempdir().unwrap();
        let key = "a".repeat(64);
        let png = include_bytes!("../icons/32x32.png");
        let url = format!("data:image/png;base64,{}", STANDARD.encode(png));
        save_preview(dir.path(), &key, &url).unwrap();
        assert_eq!(load_preview(dir.path(), &key).unwrap(), Some(url));
        assert!(save_preview(dir.path(), "../bad", "").is_err());
        assert!(save_preview(dir.path(), &key, "data:image/png;base64,AAAA").is_err());
        let mut oversized = png.to_vec();
        oversized[16..20].copy_from_slice(&1601u32.to_be_bytes());
        assert!(validate_png(&oversized).is_err());
    }
}

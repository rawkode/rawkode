use super::*;
use loro::ExportMode;
use tempfile::tempdir;

fn snapshot(day: &str, version: i64, text: &str) -> Vec<u8> {
    let doc = LoroDoc::new();
    let metadata = doc.get_map("metadata");
    metadata.insert("schemaVersion", version).unwrap();
    metadata.insert("day", day).unwrap();
    if version == 3 {
        metadata.insert("binding", "loro-prosemirror").unwrap();
        metadata.insert("bindingVersion", "0.4.4").unwrap();
        metadata.insert("editorSchema", 1_i64).unwrap();
        let root = doc.get_map("doc");
        root.insert("nodeName", "doc").unwrap();
        root.insert("fixture", text).unwrap();
    } else {
        doc.get_text("body").insert(0, text).unwrap();
    }
    doc.export(ExportMode::Snapshot).unwrap()
}

fn request(loaded: &LoadedDay, sequence: u64, text: &str) -> SaveRequest {
    SaveRequest {
        day: loaded.day.clone(),
        token: loaded.token.clone(),
        sequence,
        base_revision: loaded.revision,
        snapshot: snapshot(&loaded.day, 3, text),
    }
}

#[test]
fn browsing_is_read_only_and_first_edit_round_trips() {
    let temporary = tempdir().unwrap();
    let directory = temporary.path().join("notes");
    let mut store = NoteStore::new(directory.clone(), None);
    let loaded = store.load_day("2026-09-08").unwrap();
    assert!(loaded.snapshot.is_none());
    assert!(!directory.exists());
    assert_eq!(store.load_day("2026-09-08").unwrap().token, loaded.token);
    let request = request(&loaded, 1, "first");
    let bytes = request.snapshot.clone();
    assert_eq!(
        store.save_day(request.clone()).unwrap(),
        SaveReceipt {
            revision: 1,
            sequence: 1
        }
    );
    assert_eq!(
        store.save_day(request).unwrap(),
        SaveReceipt {
            revision: 1,
            sequence: 1
        }
    );
    let mut reopened = NoteStore::new(directory, None);
    assert_eq!(
        reopened.load_day("2026-09-08").unwrap().snapshot,
        Some(bytes)
    );
}

#[test]
fn lease_sequence_revision_and_metadata_reject_stale_or_misdirected_saves() {
    let temporary = tempdir().unwrap();
    let mut store = NoteStore::new(temporary.path().join("notes"), None);
    let first = store.load_day("2026-09-08").unwrap();
    store.save_day(request(&first, 1, "first")).unwrap();
    assert!(store
        .save_day(request(&first, 2, "stale revision"))
        .is_err());
    let current = store.load_day("2026-09-08").unwrap();
    let mut wrong_day = request(&current, 2, "wrong metadata");
    wrong_day.snapshot = snapshot("2026-09-09", 3, "wrong day");
    assert!(store.save_day(wrong_day).is_err());
    let next = store.load_day("2026-09-09").unwrap();
    assert_ne!(next.token, first.token);
    assert!(store.save_day(request(&current, 2, "old lease")).is_err());
    assert!(!temporary.path().join("notes/2026-09-09.loro").exists());
}

#[test]
fn failed_write_pins_snapshot_blocks_navigation_and_quit_then_retries() {
    let temporary = tempdir().unwrap();
    let mut store = NoteStore::new(temporary.path().join("notes"), None);
    let loaded = store.load_day("2026-09-08").unwrap();
    let request = request(&loaded, 3, "retained");
    assert!(store
        .save_using(request.clone(), |_, _| Err("injected write failure".into()))
        .is_err());
    let pending = store.load_day(&loaded.day).unwrap();
    assert!(pending.dirty);
    assert_eq!(pending.snapshot, Some(request.snapshot.clone()));
    assert!(store.load_day("2026-09-09").is_err());
    assert!(store.can_finish_quit(Some(&loaded.token), 0).is_err());
    let receipt = store.save_day(request).unwrap();
    assert_eq!(receipt.sequence, 3);
    assert!(store.can_finish_quit(Some(&loaded.token), 3).is_ok());
    assert!(store.can_finish_quit(Some(&loaded.token), 0).is_err());
    assert!(store.load_day("2026-09-09").is_ok());
}

#[test]
fn newer_pending_snapshot_supersedes_failed_one_without_accepting_old_callbacks() {
    let temporary = tempdir().unwrap();
    let mut store = NoteStore::new(temporary.path().join("notes"), None);
    let loaded = store.load_day("2026-09-08").unwrap();
    let old = request(&loaded, 1, "old");
    assert!(store
        .save_using(old.clone(), |_, _| Err("fail".into()))
        .is_err());
    let new = request(&loaded, 2, "new");
    assert!(store
        .save_using(new.clone(), |_, _| Err("fail".into()))
        .is_err());
    assert!(store.save_day(old).is_err());
    store.save_day(new.clone()).unwrap();
    assert_eq!(
        store.load_day(&loaded.day).unwrap().snapshot,
        Some(new.snapshot)
    );
}

#[test]
fn migration_backs_up_before_save_and_never_changes_legacy_original() {
    let temporary = tempdir().unwrap();
    let legacy_dir = temporary.path().join("legacy");
    let directory = temporary.path().join("notes");
    fs::create_dir(&legacy_dir).unwrap();
    let legacy = snapshot("2026-09-08", 2, "preserve");
    fs::write(legacy_dir.join("2026-09-08.loro"), &legacy).unwrap();
    let mut store = NoteStore::new(directory.clone(), Some(legacy_dir.clone()));
    let loaded = store.load_day("2026-09-08").unwrap();
    assert_eq!(loaded.legacy, Some(legacy.clone()));
    assert!(!directory.exists());
    let edit = request(&loaded, 1, "converted");
    assert!(store
        .save_using(edit.clone(), |path, bytes| {
            if path.file_name().unwrap() == "2026-09-08.loro" {
                Err("main write failed".into())
            } else {
                atomic_write(path, bytes)
            }
        })
        .is_err());
    assert_eq!(
        fs::read(directory.join("2026-09-08.legacy.loro")).unwrap(),
        legacy
    );
    assert!(!directory.join("2026-09-08.loro").exists());
    store.save_day(edit).unwrap();
    assert_eq!(
        fs::read(legacy_dir.join("2026-09-08.loro")).unwrap(),
        legacy
    );
}

#[test]
fn mismatching_backup_or_corrupt_authoritative_file_never_overwrites() {
    let temporary = tempdir().unwrap();
    let legacy_dir = temporary.path().join("legacy");
    let directory = temporary.path().join("notes");
    fs::create_dir_all(&legacy_dir).unwrap();
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        legacy_dir.join("2026-09-08.loro"),
        snapshot("2026-09-08", 1, "legacy"),
    )
    .unwrap();
    fs::write(
        directory.join("2026-09-08.legacy.loro"),
        b"different backup",
    )
    .unwrap();
    let mut store = NoteStore::new(directory.clone(), Some(legacy_dir));
    let loaded = store.load_day("2026-09-08").unwrap();
    assert!(store.save_day(request(&loaded, 1, "new")).is_err());
    assert!(!directory.join("2026-09-08.loro").exists());
    fs::write(directory.join("2026-09-08.loro"), b"corrupt").unwrap();
    let mut reopened = NoteStore::new(directory.clone(), None);
    assert!(reopened.load_day("2026-09-08").is_err());
    assert_eq!(
        fs::read(directory.join("2026-09-08.loro")).unwrap(),
        b"corrupt"
    );
}

#[test]
fn date_validation_rejects_paths_and_invalid_calendar_dates() {
    for invalid in [
        "../secrets",
        "2026-02-29",
        "2024-13-01",
        "0000-01-01",
        "2026-09-00",
        "2026-9-8",
        "2026-09-08/../../",
    ] {
        assert!(validate_day(invalid).is_err(), "{invalid}");
    }
    for valid in ["2024-02-29", "2000-02-29", "2026-09-08"] {
        assert!(validate_day(valid).is_ok());
    }
}

#[test]
fn official_javascript_binding_snapshot_round_trips_without_changes() {
    let bytes = include_bytes!("fixtures/tiptap-v3.loro").to_vec();
    let dir = tempfile::tempdir().unwrap();
    let mut store = NoteStore::new(dir.path().join("notes"), None);
    let loaded = store.load_day("2026-09-08").unwrap();
    store
        .save_day(SaveRequest {
            day: loaded.day,
            token: loaded.token,
            sequence: 1,
            base_revision: 0,
            snapshot: bytes.clone(),
        })
        .unwrap();
    let mut reopened = NoteStore::new(dir.path().join("notes"), None);
    assert_eq!(
        reopened.load_day("2026-09-08").unwrap().snapshot,
        Some(bytes)
    );
}

#[test]
fn failed_day_load_keeps_previous_lease_valid() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = NoteStore::new(dir.path().to_path_buf(), None);
    let loaded = store.load_day("2026-09-08").unwrap();
    fs::write(dir.path().join("2026-09-09.loro"), b"corrupt").unwrap();
    assert!(store.load_day("2026-09-09").is_err());
    store.can_finish_quit(Some(&loaded.token), 0).unwrap();
    store.save_day(request(&loaded, 1, "original day")).unwrap();
}

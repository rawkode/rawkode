//! Embeds the source revision so every UI can show which build is running.
//! Nix builds have no Git checkout and pass `MULTIPASS_BUILD_REVISION` instead.

use std::{path::Path, process::Command};

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn main() {
    println!("cargo:rerun-if-env-changed=MULTIPASS_BUILD_REVISION");
    let revision = std::env::var("MULTIPASS_BUILD_REVISION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            for path in ["HEAD", "index"] {
                if let Some(path) =
                    git(&["rev-parse", "--path-format=absolute", "--git-path", path])
                {
                    if Path::new(&path).exists() {
                        println!("cargo:rerun-if-changed={path}");
                    }
                }
            }
            let commit = git(&["rev-parse", "--short=12", "HEAD"])?;
            // Only changes under the app make its build differ from the commit.
            let dirty = git(&[
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--",
                "../..",
            ])
            .is_some_and(|status| !status.is_empty());
            Some(if dirty {
                format!("{commit}-dirty")
            } else {
                commit
            })
        })
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=MULTIPASS_BUILD_REVISION={revision}");
}

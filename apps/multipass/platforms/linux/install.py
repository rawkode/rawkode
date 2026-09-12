#!/usr/bin/env python3
"""Build/package the engine and install a native GTK4 user application."""
import argparse
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", type=Path, default=Path.home() / ".local")
    parser.add_argument("--engine", type=Path, help="Package an already-built engine instead of building Rust")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    root = source.parent.parent
    engine = args.engine
    if engine is None:
        subprocess.run(["cargo", "build", "--locked", "--release", "--package", "multipass-core", "--bin", "multipass-engine"], cwd=root, check=True)
        engine = root / "target/release/multipass-engine"
    engine = engine.resolve(strict=True)
    prefix = args.prefix.resolve()
    target = prefix / "libexec/multipass"
    binaries = prefix / "bin"
    applications = prefix / "share/applications"
    for directory in (target, binaries, applications):
        directory.mkdir(parents=True, exist_ok=True)
    for name in ("multipass.py", "engine_client.py", "pairing_dialogs.py"):
        shutil.copy2(source / name, target / name)
    shutil.copyfile(engine, target / "multipass-engine")
    (target / "multipass-engine").chmod(0o755)
    launcher = binaries / "multipass"
    launcher.write_text(
        "#!/usr/bin/python3\nimport runpy, sys\n"
        f"sys.path.insert(0, {str(target)!r})\n"
        f"runpy.run_path({str(target / 'multipass.py')!r}, run_name='__main__')\n"
    )
    launcher.chmod(0o755)
    # Desktop Entry escaping is distinct from shell escaping. Exec launches the
    # executable directly; no shell is involved and % must not become a field code.
    quoted = str(launcher).replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%")
    (applications / "dev.rawkode.multipass.desktop").write_text(
        "[Desktop Entry]\nType=Application\nName=Multipass\n"
        "Comment=Let your mouse follow your keyboard between computers\n"
        f'Exec="{quoted}"\n'
        "Icon=input-mouse\nTerminal=false\nCategories=Utility;\n"
        "StartupNotify=true\n"
    )
    print(f"Installed Multipass in {target}. Launch {launcher} or use your application menu.")


if __name__ == "__main__":
    main()

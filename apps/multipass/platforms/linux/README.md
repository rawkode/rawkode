# Linux frontend

Native GTK4 widgets through Python/PyGObject. The Rust engine owns devices, networking, pairing and configuration. The UI launches one engine and communicates through its stdin/stdout pipes; no shell or local HTTP server is involved.

On Debian/Ubuntu install the native runtime and Rust engine build dependencies:

```sh
sudo apt install python3-gi gir1.2-gtk-4.0 libudev-dev pkg-config libdbus-1-dev
```

Use an unlocked Secret Service provider such as GNOME Keyring or KWallet for credentials. The engine does not fall back to plaintext secret storage. Bluetooth and HID device access must be available to the normal desktop user; do not launch the GUI as root. Local network discovery requires multicast DNS and the engine's peer connection to pass the host firewall.

From this directory, with stable Rust installed:

```sh
python3 install.py
```

For a downloaded Linux package, install its adjacent prebuilt engine:

```sh
/usr/bin/python3 install.py --engine ./multipass-engine
```

The source installation builds the engine and installs under `~/.local`, including an application-menu launcher. Alternatively pass `--engine /path/to/multipass-engine` for an existing release build or `--prefix /custom/prefix` for staging. The installed launcher uses `/usr/bin/python3` so distro PyGObject packages are available. For development:

```sh
/usr/bin/python3 multipass.py --engine ../../target/release/multipass-engine
```

Choose this computer's mouse slot, pair with the other computer, then enable switching. **Keep the window open while switching. Closing it stops the engine and quits.** GTK4 has no built-in cross-desktop system tray API, so this version has an explicit window lifetime rather than a hidden process. Minimize it to keep switching. Suspend-gap handling lives in the engine.

Pairing codes are held in transient dialogs and passed through the private pipe, never written to settings or logs. The Copy button explicitly places a code on the desktop clipboard.

Transport tests do not need GTK:

```sh
python3 -m unittest discover -s tests -v
```

Actual GTK rendering, Secret Service, Bluetooth/HID access, desktop lifecycle and two-computer handoff need validation on Linux hardware. Syntax and transport checks alone do not establish those behaviors.

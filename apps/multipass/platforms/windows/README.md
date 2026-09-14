# Windows frontend

Native .NET 8 Windows Forms application. The Rust engine owns Bluetooth/HID, Bonjour-compatible discovery, settings, and credentials. The UI communicates with its adjacent `multipass-engine.exe` over private stdin/stdout pipes. No shell, TCP control port, or credential arguments are used.

Build on Windows with the .NET 8 SDK, stable Rust and Visual Studio C++ build tools:

```powershell
./package.ps1
```

The default package is a self-contained x64 app in `../../dist/windows-win-x64`. For ARM64, build a matching Rust engine and pass `-Runtime win-arm64 -EnginePath <path>`. `-EnginePath` also lets CI package an already-built engine. Distribute the whole output directory; run `Multipass.exe` as the normal user. Allow the engine's local network access through Windows Firewall when Windows asks.

Choose this computer's mouse slot, pick the other computer from the nearby list, confirm the same six-digit code on both screens, and enable switching. Closing the window leaves the app and engine in the system tray. Use **Quit Multipass** in the tray to stop both. Windows suspend/resume notifications are forwarded to the engine. The confirmation code appears only in the pairing dialog and is never stored by the UI.

Hardware handoff and Windows suspend/resume require validation on a Windows computer with the actual Bluetooth devices; cross-compilation does not establish those behaviors.

#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/dist/Multipass.app"
case "$MODE" in
run | --build | --debug | --logs | --telemetry | --verify) ;;
*)
	echo "usage: $0 [--build|--debug|--logs|--telemetry|--verify]" >&2
	exit 2
	;;
esac
cd "$ROOT_DIR"
cargo build --locked -p multipass-core --bin multipass-engine
swift build
BUILD_BINARY="$(swift build --show-bin-path)/Multipass"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$BUILD_BINARY" "$APP_BUNDLE/Contents/MacOS/Multipass"
cp target/debug/multipass-engine "$APP_BUNDLE/Contents/MacOS/multipass-engine"
cp Resources/Info.plist "$APP_BUNDLE/Contents/Info.plist"

SIGNER=/run/current-system/sw/bin/rawkos-sign-app
INSTALLER=/run/current-system/sw/bin/rawkos-install-app
STOPPER=/run/current-system/sw/bin/rawkos-stop-app
if [[ -x "$SIGNER" && -x "$INSTALLER" && -x "$STOPPER" ]]; then
	if [[ "$MODE" == --build ]]; then
		"$SIGNER" "$APP_BUNDLE" Contents/MacOS/multipass-engine
	else
		"$INSTALLER" "$APP_BUNDLE" Contents/MacOS/multipass-engine
		APP_BUNDLE="$HOME/Applications/Multipass.app"
	fi
# CI may explicitly package an ad-hoc artifact; launch modes require a certificate.
elif [[ -n "${MULTIPASS_SIGNING_IDENTITY:-}" ]] && [[ "$MULTIPASS_SIGNING_IDENTITY" != - || "$MODE" == --build ]]; then
	codesign --force --sign "$MULTIPASS_SIGNING_IDENTITY" "$APP_BUNDLE/Contents/MacOS/multipass-engine"
	codesign --force --sign "$MULTIPASS_SIGNING_IDENTITY" "$APP_BUNDLE"
	codesign --verify --deep --strict "$APP_BUNDLE"
else
	echo "Activate rawkOS signing tools or set MULTIPASS_SIGNING_IDENTITY to a stable certificate." >&2
	exit 1
fi

if [[ "$MODE" != --build ]]; then
	if [[ -x "$STOPPER" ]]; then
		"$STOPPER" Multipass multipass-engine
	else
		user_uid="$(id -u)"
		pkill -u "$user_uid" -x Multipass >/dev/null 2>&1 || true
		for _ in {1..50}; do
			if ! pgrep -u "$user_uid" -x Multipass >/dev/null && ! pgrep -u "$user_uid" -x multipass-engine >/dev/null; then break; fi
			sleep 0.1
		done
		if pgrep -u "$user_uid" -x Multipass >/dev/null || pgrep -u "$user_uid" -x multipass-engine >/dev/null; then
			echo "Multipass or its engine is still running; close it before relaunching." >&2
			exit 1
		fi
	fi
fi
case "$MODE" in
--build) echo "$APP_BUNDLE" ;;
--debug) lldb -- "$APP_BUNDLE/Contents/MacOS/Multipass" ;;
--logs | --telemetry)
	open -n "$APP_BUNDLE"
	/usr/bin/log stream --info --style compact --predicate 'process == "Multipass"'
	;;
--verify)
	cargo test --locked --workspace
	codesign --verify --deep --strict "$APP_BUNDLE"
	open -n "$APP_BUNDLE"
	sleep 1
	pgrep -x Multipass >/dev/null
	;;
run) open -n "$APP_BUNDLE" ;;
esac

#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVELOPMENT_BUNDLE="$ROOT_DIR/dist/Multipass.app"
case "$MODE" in
run | --build | --debug | --logs | --telemetry | --verify) ;;
*)
	echo "usage: $0 [--build|--debug|--logs|--telemetry|--verify]" >&2
	exit 2
	;;
esac
cd "$ROOT_DIR"
# Serialize builds and promotion, retaining the lock inode between runs.
mkdir -p "$ROOT_DIR/dist"
exec 9>"$ROOT_DIR/dist/.multipass-build.lock"
/usr/bin/lockf -t 0 9
staging="$(mktemp -d "$ROOT_DIR/dist/.multipass-build.XXXXXX")"
APP_BUNDLE="$staging/Multipass.app"
backup="$staging/previous"
promoted=false
cleanup() {
	status="$?"
	if [[ "$promoted" == false ]] && { [[ -e "$backup" ]] || [[ -L "$backup" ]]; }; then
		if [[ ! -e "$DEVELOPMENT_BUNDLE" && ! -L "$DEVELOPMENT_BUNDLE" ]]; then
			if ! mv "$backup" "$DEVELOPMENT_BUNDLE"; then
				echo "Restore the previous development app from $backup." >&2
				return 1
			fi
		else
			echo "Development destination changed; previous app retained at $backup." >&2
			return 1
		fi
	fi
	rm -rf "$staging"
	return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
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
	"$SIGNER" "$APP_BUNDLE" Contents/MacOS/multipass-engine
	if [[ "$MODE" != --build ]]; then
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
# Promote only a verified bundle, after launch modes have stopped the old app.
if [[ -e "$DEVELOPMENT_BUNDLE" || -L "$DEVELOPMENT_BUNDLE" ]]; then
	mv "$DEVELOPMENT_BUNDLE" "$backup"
fi
mv "$staging/Multipass.app" "$DEVELOPMENT_BUNDLE"
promoted=true
if [[ "$APP_BUNDLE" == "$staging/Multipass.app" ]]; then
	APP_BUNDLE="$DEVELOPMENT_BUNDLE"
fi
rm -rf "$staging"
# Long-lived log/debug sessions must not retain the build lock.
exec 9>&-
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

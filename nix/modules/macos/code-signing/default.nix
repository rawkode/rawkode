# Stable code signing for locally built macOS apps.
#
# Nix builds use ad-hoc signatures. macOS cannot carry permission grants from
# those signatures across changed builds. Install and development launchers
# use the same host signing tools instead.
#
# This module keeps one code-signing identity per host and re-signs each
# registered app with it whenever it is installed, so the signature, and the
# Accessibility and Input Monitoring grants, survive rebuilds. By default the
# identity is a self-signed certificate generated once into its own keychain
# (with a stored random password) and trusted for code signing only. Set
# `identity` to use a certificate from the primary user's login keychain
# instead. An Apple-issued identity, for example Apple Development, is
# recommended for reliable Local Network permission tracking.
{
  flake.darwinModules.macos-code-signing =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.darwin.codeSigning;
      user = config.system.primaryUser;
      managedIdentity = "rawkOS Local Code Signing";
      identityName = if cfg.identity != null then cfg.identity else managedIdentity;
      managed = cfg.identity == null;
      openssl = "${pkgs.openssl.bin}/bin/openssl";
      supportDir = "$HOME/Library/Application Support/rawkOS/code-signing";

      appModule = lib.types.submodule {
        options = {
          bundle = lib.mkOption {
            type = lib.types.path;
            description = "The built .app bundle to install into ~/Applications.";
          };
          executables = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            example = [ "Contents/MacOS/helper" ];
            description = "Extra Mach-O files inside the bundle to sign before the bundle itself.";
          };
        };
      };

      # Phase 1, as the primary user: make sure the identity exists and export
      # its certificate for the trust step. The private key never leaves the
      # keychain; the keychain password is readable only by the user.
      prepareScript = pkgs.writeText "rawkos-code-signing-prepare.sh" ''
        set -eu
        dir="${supportDir}"
        keychain="$dir/signing.keychain-db"
        password="$dir/keychain-password"
        certificate="$dir/certificate.pem"
        if [ -f "$keychain" ] && [ -f "$password" ] && [ -f "$certificate" ]; then
          exit 0
        fi
        if [ -e "$keychain" ] || [ -e "$password" ] || [ -e "$certificate" ]; then
          echo "error: local signing identity is incomplete; restore it rather than replacing its certificate" >&2
          exit 1
        fi
        echo "Creating this host's local code-signing identity..."
        mkdir -p "$dir"
        chmod 700 "$dir"
        umask 077
        head -c 32 /dev/urandom | base64 > "$password"
        work="$(mktemp -d)"
        trap 'rm -rf "$work"' EXIT
        ${openssl} req -x509 -newkey rsa:2048 -nodes -days 3650 \
          -subj "/CN=${managedIdentity}" \
          -addext "extendedKeyUsage=codeSigning" \
          -addext "keyUsage=digitalSignature" \
          -addext "basicConstraints=CA:FALSE" \
          -keyout "$work/key.pem" -out "$certificate" 2>/dev/null
        ${openssl} pkcs12 -export -legacy -inkey "$work/key.pem" -in "$certificate" \
          -out "$work/identity.p12" -passout pass:local -name "${managedIdentity}"
        /usr/bin/security create-keychain -p "$(cat "$password")" "$keychain"
        /usr/bin/security set-keychain-settings "$keychain"
        /usr/bin/security unlock-keychain -p "$(cat "$password")" "$keychain"
        /usr/bin/security import "$work/identity.p12" -k "$keychain" -P local -T /usr/bin/codesign >/dev/null
        /usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
          -k "$(cat "$password")" "$keychain" >/dev/null
      '';

      # Phase 2, as root: trust the host's certificate for code signing in the
      # admin trust domain. codesign refuses an untrusted identity, even by
      # hash. Scoped to the code-signing policy; idempotent.
      trustScript = pkgs.writeText "rawkos-code-signing-trust.sh" ''
        set -eu
        certificate="$1"
        if [ ! -f "$certificate" ]; then
          echo "error: local code-signing certificate is missing" >&2
          exit 1
        fi
        if /usr/bin/security verify-cert -c "$certificate" -p codeSign -L >/dev/null 2>&1; then
          exit 0
        fi
        echo "Trusting this host's local code-signing certificate..."
        /usr/bin/security add-trusted-cert -d -r trustRoot -p codeSign \
          -k /Library/Keychains/System.keychain "$certificate" \
          || exit 1
      '';

      signApp = pkgs.writeShellScriptBin "rawkos-sign-app" ''
        set -euo pipefail
        if [ "$#" -lt 1 ]; then
          echo "usage: rawkos-sign-app APP_BUNDLE [HELPER_PATH ...]" >&2
          exit 2
        fi
        bundle="$1"
        shift
        ${lib.optionalString managed ''
          keychain="${supportDir}/signing.keychain-db"
          password="${supportDir}/keychain-password"
          # codesign only finds identities in keychains on the user's search
          # list, even when told --keychain, so add ours once. `-s` replaces
          # the whole list, so the existing entries are passed back in.
          if ! /usr/bin/security list-keychains -d user | grep -qF "\"$keychain\""; then
            echo "Adding the local code-signing keychain to the keychain search list..."
            mapfile -t existing < <(/usr/bin/security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"$//')
            /usr/bin/security list-keychains -d user -s "$keychain" "''${existing[@]}"
          fi
          /usr/bin/security unlock-keychain -p "$(cat "$password")" "$keychain"
        ''}
        sign() {
          /usr/bin/codesign --force ${lib.optionalString managed ''--keychain "$keychain"''} --sign ${lib.escapeShellArg identityName} "$1"
        }
        for executable in "$@"; do
          sign "$bundle/$executable"
        done
        sign "$bundle"
        /usr/bin/codesign --verify --deep --strict "$bundle"
      '';

      installAppScript = pkgs.writeShellScript "rawkos-install-app-locked" ''
        set -euo pipefail
        if [ "$#" -lt 1 ] || [ ! -d "$1/Contents/MacOS" ]; then
          echo "usage: rawkos-install-app APP_BUNDLE [HELPER_PATH ...]" >&2
          exit 2
        fi
        source="$1"
        shift
        name="$(basename "$source")"
        case "$name" in
          *.app) ;;
          *) echo "error: expected an .app bundle" >&2; exit 2 ;;
        esac
        mkdir -p "$HOME/Applications"
        # The worker owns this descriptor through installation and EXIT cleanup.
        # Keep the inode so competing installers always lock the same file.
        exec 9> "$HOME/Applications/.rawkos-install-$name.lock"
        /usr/bin/lockf -t 0 9
        staging="$(mktemp -d "$HOME/Applications/.rawkos-install.XXXXXX")"
        target="$HOME/Applications/$name"
        backup="$staging/previous"
        installed=false
        cleanup() {
          status="$?"
          if [ "$installed" = false ] && { [ -e "$backup" ] || [ -L "$backup" ]; }; then
            if [ ! -e "$target" ] && [ ! -L "$target" ]; then
              if ! mv "$backup" "$target"; then
                echo "error: restore the previous app from $backup" >&2
                return 1
              fi
            else
              echo "error: destination changed during installation; previous app retained at $backup" >&2
              return 1
            fi
          fi
          rm -rf "$staging"
          return "$status"
        }
        trap cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' HUP TERM
        cp -RL "$source" "$staging/$name"
        chmod -R u+w "$staging/$name"
        ${signApp}/bin/rawkos-sign-app "$staging/$name" "$@"
        # Signing failure leaves the previous installation untouched.
        if [ -e "$target" ] || [ -L "$target" ]; then
          mv "$target" "$backup"
        fi
        mv "$staging/$name" "$target"
        installed=true
      '';

      installApp = pkgs.writeShellScriptBin "rawkos-install-app" ''
        set -euo pipefail
        if [ "$#" -lt 1 ]; then
          echo "usage: rawkos-install-app APP_BUNDLE [HELPER_PATH ...]" >&2
          exit 2
        fi
        exec ${installAppScript} "$@"
      '';

      stopApp = pkgs.writeShellScriptBin "rawkos-stop-app" ''
        set -euo pipefail
        if [ "$#" -lt 1 ]; then
          echo "usage: rawkos-stop-app APP_PROCESS [HELPER_PROCESS ...]" >&2
          exit 2
        fi
        user_uid="$(id -u)"
        /usr/bin/pkill -u "$user_uid" -x "$1" >/dev/null 2>&1 || true
        for _ in {1..50}; do
          running=false
          for process in "$@"; do
            if /usr/bin/pgrep -u "$user_uid" -x "$process" >/dev/null; then
              running=true
              break
            fi
          done
          if [ "$running" = false ]; then
            exit 0
          fi
          sleep 0.1
        done
        echo "error: $1 or its helper is still running; close it before relaunching" >&2
        exit 1
      '';

      # Phase 3, as the primary user: install verified, signed copies.
      installScript = pkgs.writeText "rawkos-code-signing-install.sh" ''
        set -euo pipefail
        ${lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: app: ''
            echo "Installing ${name} to ~${user}/Applications..."
            ${installApp}/bin/rawkos-install-app ${lib.escapeShellArg (toString app.bundle)} ${lib.escapeShellArgs app.executables}
          '') cfg.apps
        )}
      '';

      asUser =
        script:
        "launchctl asuser \"$(id -u ${user})\" sudo --user=${user} --set-home ${pkgs.runtimeShell} ${script}";
      userHome = ''"$(sudo --user=${user} --set-home ${pkgs.runtimeShell} -c 'echo "$HOME"')"'';
    in
    {
      options.rawkOS.darwin.codeSigning = {
        identity = lib.mkOption {
          type = lib.types.nullOr (lib.types.strMatching "[^'\"$`\\\\]+");
          default = null;
          example = "Apple Development: Jane Doe (TEAMID1234)";
          description = ''
            Code-signing identity from the primary user's login keychain to sign
            installed apps with. Null generates and trusts a self-signed
            certificate once per host and uses that.
          '';
        };
        apps = lib.mkOption {
          type = lib.types.attrsOf appModule;
          default = { };
          description = "Apps to install into ~/Applications and sign, keyed by bundle name such as \"Foo.app\".";
        };
      };

      config = lib.mkIf (cfg.apps != { }) {
        assertions = [
          {
            assertion = cfg.identity != "-";
            message = "rawkOS.darwin.codeSigning.identity must be a stable certificate, not the ad-hoc '-' identity";
          }
        ];
        environment.systemPackages = [
          signApp
          installApp
          stopApp
        ];
        # nix-darwin runs activation as root with HOME=~root. Copying and
        # signing run as the primary user inside their GUI session; trusting the
        # certificate needs root and runs directly.
        system.activationScripts.postActivation.text = lib.mkAfter ''
          ${lib.optionalString managed ''
            ${asUser prepareScript}
            ${pkgs.runtimeShell} ${trustScript} ${userHome}/Library/Application\ Support/rawkOS/code-signing/certificate.pem
          ''}
          ${asUser installScript}
        '';
      };
    };
}

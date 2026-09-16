# Stable code signing for locally built macOS apps.
#
# Nix can only sign app bundles ad-hoc, and macOS ties Accessibility, Input
# Monitoring, Local Network and keychain-item access to the app's code
# signature. An ad-hoc signature is just the hash of the binary, so every
# rebuild silently invalidates every grant while System Settings still shows
# them enabled.
#
# This module keeps one code-signing identity per host and re-signs each
# registered app with it whenever it is installed, so the signature, and the
# grants tied to it, survive rebuilds. By default the identity is a self-signed
# certificate generated once into its own keychain (with a stored random
# password, so codesign never prompts) and trusted for code signing only. Set
# `identity` to use a certificate from the primary user's login keychain
# instead, for example an Apple Development identity.
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
        echo "Creating this host's local code-signing identity..."
        rm -rf "$dir"
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
        certificate="$1"
        if [ ! -f "$certificate" ]; then
          echo "warning: local code-signing certificate is missing; apps keep their ad-hoc signatures" >&2
          exit 0
        fi
        if /usr/bin/security verify-cert -c "$certificate" -p codeSign -L >/dev/null 2>&1; then
          exit 0
        fi
        echo "Trusting this host's local code-signing certificate..."
        /usr/bin/security add-trusted-cert -d -r trustRoot -p codeSign \
          -k /Library/Keychains/System.keychain "$certificate" \
          || echo "warning: could not trust the local code-signing certificate" >&2
      '';

      # Phase 3, as the primary user: install each app into ~/Applications
      # (Spotlight and Launchpad skip symlinked bundles) and sign it.
      installScript = pkgs.writeText "rawkos-code-signing-install.sh" ''
        set -u
        mkdir -p "$HOME/Applications"
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
          /usr/bin/codesign --force ${lib.optionalString managed ''--keychain "$keychain"''} --sign "${identityName}" "$1"
        }
        ${lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: app: ''
            echo "Installing ${name} to ~${user}/Applications..."
            target="$HOME/Applications/${name}"
            rm -rf "$target"
            cp -RL "${app.bundle}" "$target"
            chmod -R u+w "$target"
            ${lib.concatMapStringsSep "\n" (exe: ''sign "$target/${exe}" &&'') app.executables} \
              sign "$target" \
              || echo "warning: could not sign ${name}; it keeps its ad-hoc signature" >&2
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
        # nix-darwin runs activation as root with HOME=~root. Copying and
        # signing run as the primary user inside their GUI session; trusting the
        # certificate needs root and runs directly.
        system.activationScripts.postActivation.text = lib.mkAfter ''
          ${lib.optionalString managed ''
            ${asUser prepareScript} || echo "warning: could not prepare the local code-signing identity" >&2
            ${pkgs.runtimeShell} ${trustScript} ${userHome}/Library/Application\ Support/rawkOS/code-signing/certificate.pem
          ''}
          ${asUser installScript} || echo "warning: installing signed apps failed" >&2
        '';
      };
    };
}

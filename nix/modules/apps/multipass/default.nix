{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "multipass";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.multipass.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };

  linux.system =
    { pkgs, ... }:
    {
      # Run before 73-seat-late.rules so logind grants the active session access.
      # The keyboard is detected through metadata and needs no device ACL.
      services.udev.packages = [
        (pkgs.writeTextDir "lib/udev/rules.d/70-multipass-mx4.rules" ''
          ACTION=="add|change", SUBSYSTEM=="hidraw", KERNELS=="0005:046D:B042.*", TAG+="uaccess"
        '')
      ];
    };

  darwin.system =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      multipassPkg = inputs.multipass.packages.${pkgs.stdenv.hostPlatform.system}.default;
      user = config.system.primaryUser;
      identity = config.rawkOS.apps.multipass.signingIdentity;
    in
    {
      options.rawkOS.apps.multipass.signingIdentity = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "[^'\"$`\\]+");
        default = null;
        example = "Apple Development: Jane Doe (TEAMID1234)";
        description = ''
          Code-signing identity from the primary user's login keychain used to
          re-sign the installed app. The Nix build can only sign ad-hoc, and
          macOS keys Input Monitoring, Local Network and keychain access to the
          code signature, so every rebuild silently invalidates those grants.
          A stable identity keeps them across rebuilds. Null keeps the ad-hoc
          signature.
        '';
      };

      # Copy to ~/Applications instead of linking from home.packages.
      # Spotlight and Launchpad skip symlinked bundles under "Home Manager Apps".
      # nix-darwin runs this as root with HOME=~root, so switch to the primary
      # user or the bundle lands in /var/root/Applications.
      config.system.activationScripts.postActivation.text = ''
        echo "Installing Multipass.app to ~${user}/Applications..."
        sudo --user=${user} --set-home ${pkgs.runtimeShell} -c '
          mkdir -p "$HOME/Applications"
          rm -rf "$HOME/Applications/Multipass.app"
          cp -RL "${multipassPkg}/Applications/Multipass.app" "$HOME/Applications/"
          chmod -R u+w "$HOME/Applications/Multipass.app"
          ${lib.optionalString (identity != null) ''
            echo "Signing Multipass.app as ${identity}..."
            /usr/bin/codesign --force --sign "${identity}" "$HOME/Applications/Multipass.app/Contents/MacOS/multipass-engine" \
              && /usr/bin/codesign --force --sign "${identity}" "$HOME/Applications/Multipass.app" \
              || echo "warning: could not sign Multipass.app with ${identity}; it keeps its ad-hoc signature" >&2
          ''}
        '
      '';
    };
}

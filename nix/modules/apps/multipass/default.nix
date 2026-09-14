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
    { pkgs, ... }:
    let
      multipassPkg = inputs.multipass.packages.${pkgs.stdenv.hostPlatform.system}.default;
    in
    {
      # Copy to ~/Applications instead of linking from home.packages.
      # Spotlight and Launchpad skip symlinked bundles under "Home Manager Apps",
      # and macOS grants Input Monitoring by path — running from /nix/store
      # means every rebuild requires re-granting permissions.
      system.activationScripts.postActivation.text = ''
        echo "Installing Multipass.app to ~/Applications..."
        mkdir -p "$HOME/Applications"
        rm -rf "$HOME/Applications/Multipass.app"
        cp -RL "${multipassPkg}/Applications/Multipass.app" "$HOME/Applications/"
        chmod -R u+w "$HOME/Applications/Multipass.app"
      '';
    };
}

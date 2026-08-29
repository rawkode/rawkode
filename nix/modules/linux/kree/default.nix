_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "kree";

  darwin.system =
    { inputs, pkgs, ... }:
    let
      kreePkg = inputs.kree.packages.${pkgs.stdenv.hostPlatform.system}.default;
    in
    {
      # Copy to ~/Applications so the binary path stays stable across rebuilds.
      # macOS grants Accessibility permissions by path — running from /nix/store
      # means every rebuild requires re-granting permissions.
      system.activationScripts.postActivation.text = ''
        echo "Installing Kree.app to ~/Applications..."
        mkdir -p "$HOME/Applications"
        rm -rf "$HOME/Applications/Kree.app"
        cp -RL "${kreePkg}/Applications/Kree.app" "$HOME/Applications/"
        chmod -R u+w "$HOME/Applications/Kree.app"
      '';
    };
}

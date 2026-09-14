_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "kree";

  darwin.system =
    {
      config,
      inputs,
      pkgs,
      ...
    }:
    let
      kreePkg = inputs.kree.packages.${pkgs.stdenv.hostPlatform.system}.default;
      user = config.system.primaryUser;
    in
    {
      # Copy to ~/Applications so the binary path stays stable across rebuilds.
      # macOS grants Accessibility permissions by path — running from /nix/store
      # means every rebuild requires re-granting permissions.
      # nix-darwin runs this as root with HOME=~root, so switch to the primary
      # user or the bundle lands in /var/root/Applications.
      system.activationScripts.postActivation.text = ''
        echo "Installing Kree.app to ~${user}/Applications..."
        sudo --user=${user} --set-home ${pkgs.runtimeShell} -c '
          mkdir -p "$HOME/Applications"
          rm -rf "$HOME/Applications/Kree.app"
          cp -RL "${kreePkg}/Applications/Kree.app" "$HOME/Applications/"
          chmod -R u+w "$HOME/Applications/Kree.app"
        '
      '';
    };
}

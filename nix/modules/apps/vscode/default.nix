{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit (inputs.nixpkgs) lib; };
in
mkApp {
  name = "visual-studio-code";

  home =
    { pkgs, ... }:
    {
      programs.vscode = {
        enable = true;
        package = pkgs.vscode-fhs;
      };

      stylix.targets.vscode.enable = false;

      programs.niri.settings.window-rules = [
        {
          matches = [
            { app-id = "code"; }
          ];
          open-focused = true;
          opacity = 0.95;
        }
      ];

      home.file.".vscode/argv.json".text = builtins.toJSON {
        password-store = "gnome-libsecret";
        ozone-platform-hint = "auto";
        ozone-platform = "wayland";
        gtk-version = 4;
        enable-wayland-ime = true;
        enable-crash-reporter = false;
      };
    };

  darwin =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "visual-studio-code" ];
      };
    };
}

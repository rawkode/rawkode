{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "visual-studio-code";

  # Common config that works on both platforms
  common.home = _: {
    stylix.targets.vscode.enable = false;
  };

  # Linux: use vscode-fhs package via home-manager
  linux.home =
    { pkgs, ... }:
    {
      programs.vscode = {
        enable = true;
        package = pkgs.vscode-fhs;
      };

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

  # Darwin: install via homebrew cask (no home-manager vscode config needed)
  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "visual-studio-code" ];
      };
    };
}

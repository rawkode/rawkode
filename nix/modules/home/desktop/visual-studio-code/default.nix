{ pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    package = pkgs.vscode-fhs;
  };

  stylix.targets.vscode.enable = false;

  home.file.".vscode/argv.json".text = builtins.toJSON {
    password-store = "gnome-libsecret";
    ozone-platform-hint = "auto";
    ozone-platform = "wayland";
    gtk-version = 4;
    enable-wayland-ime = true;
    enable-crash-reporter = false;
  };
}

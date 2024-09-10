{
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.gnome;
  burnMyWindowsProfile = pkgs.writeText "burn-my-windows.conf" ''
    [burn-my-windows-profile]
    energize-b-enable-effect=true
    energize-b-scale=10.0
    energize-b-animation-time=500
  '';
in
{
  config = mkIf cfg.enable {
    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "burn-my-windows@schneegans.github.com" ];
      };
      "org/gnome/shell/extensions/burn-my-windows" = {
        active-profile = "${burnMyWindowsProfile}";
      };
    };

    systemd.user.tmpfiles.rules = [
      "L+ %h/.config/burn-my-windows/profiles/nix-profile.conf 0755 - - - ${burnMyWindowsProfile}"
    ];

    home.packages = with pkgs.gnomeExtensions; [ burn-my-windows ];
  };
}

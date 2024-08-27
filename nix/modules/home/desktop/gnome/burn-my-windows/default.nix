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
    energize-b-animation-time=768
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

    home.packages = with pkgs.gnomeExtensions; [ burn-my-windows ];
  };
}

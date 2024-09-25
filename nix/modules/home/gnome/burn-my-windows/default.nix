{
  lib,
  pkgs,
  ...
}:
with lib;
let
  burnMyWindowsProfile = pkgs.writeText "burn-my-windows.conf" ''
    [burn-my-windows-profile]
    energize-b-enable-effect=true
    energize-b-scale=10.0
    energize-b-animation-time=500
  '';
in
{
  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "burn-my-windows@schneegans.github.com" ];
    };
    "org/gnome/shell/extensions/burn-my-windows" = {
      active-profile = "${burnMyWindowsProfile}";
    };
  };

  home.packages = with pkgs.gnomeExtensions; [ burn-my-windows ];
}

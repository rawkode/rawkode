{
  lib,
  pkgs,
  ...
}:
with lib;
{

  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "rclone-manager@germanztz.com" ];
    };
  };

  home.packages = with pkgs; [ rclone ] ++ (with pkgs.gnomeExtensions; [ rclone-manager ]);

}

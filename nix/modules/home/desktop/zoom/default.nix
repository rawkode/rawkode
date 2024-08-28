{ pkgs, ... }:
{
  home.packages = (with pkgs; [ zoom-us ]);

  dconf.settings = {
    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [ "zoom.desktop:1" ];
    };
  };
}

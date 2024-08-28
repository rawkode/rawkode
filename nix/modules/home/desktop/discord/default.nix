{ pkgs, ... }:
{
  home.packages = (with pkgs; [ vesktop ]);

  dconf.settings = {
    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [ "vesktop.desktop:2" ];
    };
  };
}

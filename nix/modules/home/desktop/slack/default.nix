{ pkgs, ... }:
{
  home.packages = (with pkgs; [ slack ]);

  dconf.settings = {
    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [ "slack.desktop:2" ];
    };
  };
}

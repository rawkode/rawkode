{
  flake.homeModules.gnome-transparent-window-moving =
    { pkgs, ... }:
    {
      dconf.settings = {
        "org/gnome/shell" = {
          enabled-extensions = [ "transparent-window-moving@noobsai.github.com" ];
        };

        "org/gnome/shell/extensions/transparent-window-moving" = {
          window-opacity = 128;
        };
      };

      home.packages = with pkgs.gnomeExtensions; [ transparent-window-moving ];
    };
}

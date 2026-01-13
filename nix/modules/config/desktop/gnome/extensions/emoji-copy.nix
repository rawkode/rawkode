{
  flake.homeModules.gnome-emoji-copy =
    { pkgs, ... }:
    {
      dconf.settings = {
        "org/gnome/shell" = {
          enabled-extensions = [ "emoji-copy@felipeftn" ];
        };
      };

      home.packages = with pkgs.gnomeExtensions; [ emoji-copy ];
    };
}

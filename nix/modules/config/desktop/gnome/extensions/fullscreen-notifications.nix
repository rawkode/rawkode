{
  flake.homeModules.gnome-fullscreen-notifications =
    { pkgs, ... }:
    {
      home.packages = with pkgs.gnomeExtensions; [ fullscreen-notifications ];
    };
}

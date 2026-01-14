{
  flake.homeModules.wezterm =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        wezterm
      ];

      xdg.configFile."wezterm" = {
        source = ./config;
        recursive = true;
      };
    };

  flake.darwinModules.wezterm =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "wezterm" ];
      };
    };
}

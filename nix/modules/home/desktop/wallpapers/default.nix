{ config, lib, pkgs, ... }:

let
  cfg = config.programs.wallpapers;
in
{
  options.programs.wallpapers = {
    enable = lib.mkEnableOption "custom wallpapers";
    
    wallpaperPath = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.config/wallpapers";
      description = "Path where wallpapers will be stored";
    };
  };

  config = lib.mkIf cfg.enable {
    # Copy wallpapers to config directory
    home.file."${cfg.wallpaperPath}/rawkode-academy.png".source = ./rawkode-academy.png;

    # Create symlink for niri
    home.file.".config/niri/wallpaper.png".source = config.lib.file.mkOutOfStoreSymlink "${cfg.wallpaperPath}/rawkode-academy.png";
  };
}
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.dconf-editor;
in
{
  options.programs.dconf-editor = {
    enable = lib.mkEnableOption "dconf editor for GNOME configuration";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.gnome.dconf-editor;
      description = "The dconf-editor package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.spotify;
in
{
  options.programs.spotify = {
    enable = lib.mkEnableOption "Spotify music streaming client";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.spotify;
      description = "The Spotify package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
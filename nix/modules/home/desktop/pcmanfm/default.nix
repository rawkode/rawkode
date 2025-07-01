{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pcmanfm;
in
{
  options.programs.pcmanfm = {
    enable = lib.mkEnableOption "PCManFM file manager";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.pcmanfm;
      description = "The PCManFM package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
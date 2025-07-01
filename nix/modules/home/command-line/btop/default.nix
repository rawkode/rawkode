{ config, lib, pkgs, ... }:

let
  cfg = config.programs.btop;
in
{
  options.programs.btop = {
    enable = lib.mkEnableOption "btop resource monitor";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.btop;
      description = "The btop package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
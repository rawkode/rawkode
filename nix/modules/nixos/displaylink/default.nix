{ config, lib, ... }:
with lib;
let
  cfg = config.rawkOS.displayLink;
in
{
  options.rawkOS.displayLink = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable DisplayLink support";
    };
  };

  config = mkIf cfg.enable {
    boot = {
      extraModulePackages = with config.boot.kernelPackages; [ evdi ];
    };

    hardware.opengl = {
      enable = true;
      extraPackages = with pkgs; [ displaylink ];
    };

    services.xserver.videoDrivers = [ "displaylink" ];
  };
}

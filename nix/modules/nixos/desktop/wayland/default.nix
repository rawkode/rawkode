{ config, lib, ... }:
with lib;
let
  cfg = config.rawkOS.desktop.wayland;
in
{
  options.rawkOS.desktop.wayland = {
    force = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to force Wayland support with NixOS environment variable.";
    };
  };

  config = mkIf cfg.force {
    environment.sessionVariables = {
      NIXOS_OZONE_WL = "1";
      QT_QPA_PLATFORM = "wayland";
    };
  };
}

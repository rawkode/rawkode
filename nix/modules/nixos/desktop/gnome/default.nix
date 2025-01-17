{ config, lib, ... }:
with lib;
let
  cfg = config.rawkOS.desktop.gnome;
in
{
  options.rawkOS.desktop.gnome = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable the GNOME";
    };

    paperwm = mkOption {
      type = types.bool;
      default = false;
    };
  };

  config = mkIf cfg.enable {
    services = {
      xserver.desktopManager.gnome.enable = true;
    };
  };
}

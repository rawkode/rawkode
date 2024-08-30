{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.rawkOS.desktop.plasma;
in
{
  options.rawkOS.desktop.plasma = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable the KDE Plasma";
    };
  };

  config = mkIf cfg.enable {
    services.xserver.enable = true;
    services.xserver.displayManager.gdm.enable = true;

    services.desktopManager.plasma6.enable = true;
    services.displayManager.defaultSession = "plasma";

    xdg.portal = {
      enable = true;
      configPackages = with pkgs; [ xdg-desktop-portal-kde ];
    };

    services.displayManager.sddm.enable = false;
    services.displayManager.sddm.wayland.enable = false;

    programs.ssh.askPassword = mkForce "${pkgs.ksshaskpass}/bin/ksshaskpass";

    environment.systemPackages = with pkgs; [
      merkuro
    ];
  };
}

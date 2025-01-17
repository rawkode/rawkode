{
  config,
  lib,
  pkgs,
  ...
}:
let
  port = 41641;
in
{
  networking.firewall.interfaces.${config.services.tailscale.interfaceName}.allowedTCPPorts = [ 22 ];
  networking.firewall.checkReversePath = "loose";

  services.tailscale = {
    enable = true;
    port = port;
    openFirewall = true;
    extraUpFlags = lib.mkDefault [ "--ssh" ];
  };

  # systemd.services.tailscaled-autoconnect =
  #   lib.mkIf (config.services.tailscale.authKeyFile != null && config.services.tailscale.enable)
  #     {
  #       serviceConfig = {
  #         RemainAfterExit = true;
  #       };
  #     };

  # systemd.user.services.nixos-activation = {
  #   after = [
  #     "tailscaled.service"
  #     "tailscaled-autoconnect.service"
  #   ];
  # };

  # system.userActivationScripts.checkTailscaleStatus =
  #   lib.mkIf
  #     (
  #       config.networking.hostName != ""
  #       && config.services.tailscale.enable
  #       && config.services.tailscale.authKeyFile != null
  #     )
  #     {
  #       text = ''
  #         #!/usr/bin/env bash

  #         ${pkgs.tailscale}/bin/tailscale ping -c 1 "${config.networking.hostName}" || \
  #           ${pkgs.systemd}/bin/systemctl restart tailscaled-autoconnect.service;
  #       '';
  #     };
}

{ lib, ... }:
{
  flake.machineManifests.p4x-desktop-nixos = {
    platform = "nixos";
    system = "x86_64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "theming"
      "peripherals-multipass"
      "desktop"
      "productivity"
      "personal-comms"
      "development"
      "platform"
      "vpn"
    ];
    disabledCapabilities = [ ];
    traits = [
      "nixos-hardware-maintenance"
      "nixos-tpm2"
      "nixos-wireless"
      "nixos-amd-desktop"
      "nixos-zen-kernel"
      "nixos-secureboot"
      "nixos-encrypted-btrfs"
    ];
    users.rawkode = {
      standaloneHomeConfiguration = false;
      modules = [
        {
          rawkOS.apps.ai.hermes.enable = true;
          rawkOS.apps.ai.bb.enable = true;
          # Listen on every interface so bb does not depend on the NetBird
          # interface existing at startup; the firewall below admits it on
          # NetBird only.
          rawkOS.apps.ai.bb.serverBindHost = "0.0.0.0";
          rawkOS.apps.ai.bb.appUrl = "http://p4x-desktop-nixos.rka.internal:38886";

          # The BenQ on DisplayPort drops its link when its monitors wake from DPMS
          # and never reconnects, so the desktop locks on idle and never powers
          # the outputs off.
          programs.noctalia.settings.idle.behavior.screen-off.enabled = false;

          # Positions are logical: each DP monitor is 1920x1080 at scale 2, the
          # same size as the HDMI monitor. DP-2 sits left of DP-1 and the HDMI
          # monitor sits directly above DP-1.
          programs.umbriel.settings.output = {
            "DP-2" = {
              mode = "3840x2160@144";
              position = [
                0
                1080
              ];
            };
            "DP-1" = {
              mode = "3840x2160@144";
              position = [
                1920
                1080
              ];
            };
            # The field monitor advertises 4K as its preferred mode, so 1080p
            # has to be pinned.
            "HDMI-A-2" = {
              mode = "1920x1080@60";
              position = [
                1920
                0
              ];
            };
          };

          # Umbriel opens a fullscreen window on the output under the pointer
          # whatever output the client requested, so the mirror window is sent
          # to the HDMI monitor here. It stays unfocused so the mirror keys
          # keep acting on the window and output being worked in.
          programs.umbriel.settings.window_rule = [
            {
              match.app_id = "^at\\.yrlf\\.wl_mirror$";
              default_output = "HDMI-A-2";
              default_fullscreen = true;
              default_focused = false;
            }
          ];
        }
      ];
    };
    modules = [
      {
        rawkOS.disko.device = "/dev/nvme0n1";
        zramSwap.enable = true;
        hardware.enableRedistributableFirmware = lib.mkDefault true;
        services.nordvpn.enable = true;
        users.users.rawkode.extraGroups = [ "nordvpn" ];

        # bb's web UI and API, reachable from NetBird peers only. NetBird access
        # policies decide which peers may connect.
        networking.firewall.interfaces.wt0.allowedTCPPorts = [ 38886 ];
      }
    ];
  };
}

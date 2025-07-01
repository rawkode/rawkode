{ config
, lib
, pkgs
, ...
}:
with lib;
let
  cfg = config.rawkOS.secureboot;
in
{
  options.rawkOS.secureboot = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to enable Secure Boot support";
    };
  };

  config = mkIf cfg.enable {
    boot = {
      # Lanzaboote currently replaces the systemd-boot module.
      # This setting is usually set to true in configuration.nix
      # generated at installation time. So we force it to false
      # for now.
      loader.systemd-boot.enable = lib.mkForce false;

      lanzaboote = {
        enable = true;
        pkiBundle = "/var/lib/sbctl";
      };
    };

    environment.systemPackages = with pkgs; [
      sbctl
      tpm2-tss
    ];
  };
}

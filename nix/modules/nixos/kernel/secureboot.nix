{
  inputs,
  lib,
  pkgs,
  ...
}:
with lib;
with lib.rawkOS;
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
    imports = [ inputs.lanzaboote.nixosModules.lanzaboote ];

    boot = {
      # Lanzaboote currently replaces the systemd-boot module.
      # This setting is usually set to true in configuration.nix
      # generated at installation time. So we force it to false
      # for now.
      loader.systemd-boot.enable = lib.mkForce false;

      lanzaboote = {
        enable = true;
        pkiBundle = "/etc/secureboot";
      };
    };

    environment.systemPackages = with pkgs; [ sbctl ];
  };
}
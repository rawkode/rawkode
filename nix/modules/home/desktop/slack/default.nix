{ config, lib, pkgs, ... }:

let
  cfg = config.programs.slack;
in
{
  options.programs.slack = {
    enable = lib.mkEnableOption "Slack desktop client";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.slack;
      description = "The Slack package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Enable Wayland support
    xdg.configFile."slack-desktop/wayland.conf".text = ''
[Context]
sockets=wayland;
    '';

    # Wayland environment variables
    home.sessionVariables = {
      NIXOS_OZONE_WL = "1";
    };
  };
}
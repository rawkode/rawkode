{ config, lib, pkgs, ... }:

let
  cfg = config.programs.zulip;
in
{
  options.programs.zulip = {
    enable = lib.mkEnableOption "Zulip team chat client";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.zulip;
      description = "The Zulip package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Enable Wayland support
    home.sessionVariables = {
      NIXOS_OZONE_WL = "1";
    };
  };
}
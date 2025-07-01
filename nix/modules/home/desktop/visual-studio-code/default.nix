{ config, lib, pkgs, ... }:

let
  cfg = config.programs.vscode;
in
{
  options.programs.vscode = {
    enable = lib.mkEnableOption "Visual Studio Code";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.vscode;
      description = "The VS Code package to use";
    };
    
    enableWayland = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable Wayland support";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.vscode = {
      inherit (cfg) package;
      enable = true;
      
      userSettings = {
        "telemetry.telemetryLevel" = "off";
        "update.mode" = "none";
        "extensions.autoUpdate" = false;
        "extensions.autoCheckUpdates" = false;
      };
    };

    # argv.json configuration
    xdg.configFile."Code/argv.json".text = ''
{
  "password-store": "gnome-libsecret",
  "enable-crash-reporter": true,
  "crash-reporter-id": "521bfdaa-436c-438a-a54b-7b820b9754b0"
}
    '';

    # Wayland flags
    home.sessionVariables = lib.mkIf cfg.enableWayland {
      NIXOS_OZONE_WL = "1";
    };
  };
}
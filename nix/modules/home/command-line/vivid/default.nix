{ config, lib, pkgs, ... }:

let
  cfg = config.programs.vivid;
in
{
  options.programs.vivid = {
    enable = lib.mkEnableOption "vivid LS_COLORS generator";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.vivid;
      description = "The vivid package to use";
    };
    
    theme = lib.mkOption {
      type = lib.types.str;
      default = "catppuccin-mocha";
      description = "The vivid theme to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Set LS_COLORS for all shells
    home.sessionVariables = {
      LS_COLORS = "$(${cfg.package}/bin/vivid generate ${cfg.theme})";
    };

    # Fish configuration
    programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
      set -gx LS_COLORS (${cfg.package}/bin/vivid generate ${cfg.theme})
    '';

    # Bash configuration
    programs.bash.initExtra = lib.mkIf config.programs.bash.enable ''
      export LS_COLORS="$(${cfg.package}/bin/vivid generate ${cfg.theme})"
    '';

    # Zsh configuration
    programs.zsh.initExtra = lib.mkIf config.programs.zsh.enable ''
      export LS_COLORS="$(${cfg.package}/bin/vivid generate ${cfg.theme})"
    '';

    # Nushell configuration
    programs.nushell.extraEnv = lib.mkIf config.programs.nushell.enable ''
      $env.LS_COLORS = (${cfg.package}/bin/vivid generate ${cfg.theme})
    '';
  };
}
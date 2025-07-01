{ config, lib, pkgs, ... }:

let
  cfg = config.programs.carapace;
in
{
  options.programs.carapace = {
    enable = lib.mkEnableOption "carapace shell completion framework";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.carapace;
      description = "The carapace package to use";
    };
    
    bridges = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "zsh" "fish" "bash" "inshellisense" ];
      description = "Shell bridges to enable";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Fish configuration
    programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
      set -Ux CARAPACE_BRIDGES '${lib.concatStringsSep "," cfg.bridges}'
      ${cfg.package}/bin/carapace _carapace | source
    '';

    # Bash configuration
    programs.bash.initExtra = lib.mkIf config.programs.bash.enable ''
      export CARAPACE_BRIDGES='${lib.concatStringsSep "," cfg.bridges}'
      source <(${cfg.package}/bin/carapace _carapace)
    '';

    # Zsh configuration
    programs.zsh.initExtra = lib.mkIf config.programs.zsh.enable ''
      export CARAPACE_BRIDGES='${lib.concatStringsSep "," cfg.bridges}'
      source <(${cfg.package}/bin/carapace _carapace)
    '';

    # Nushell configuration
    programs.nushell.extraConfig = lib.mkIf config.programs.nushell.enable ''
      $env.CARAPACE_BRIDGES = '${lib.concatStringsSep "," cfg.bridges}'
      source ~/.cache/carapace/init.nu
    '';

    programs.nushell.extraEnv = lib.mkIf config.programs.nushell.enable ''
      mkdir ~/.cache/carapace
      ${cfg.package}/bin/carapace _carapace nushell | save -f ~/.cache/carapace/init.nu
    '';
  };
}
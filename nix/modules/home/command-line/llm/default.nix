{ config, lib, pkgs, ... }:

let
  cfg = config.programs.llm;
in
{
  options.programs.llm = {
    enable = lib.mkEnableOption "LLM CLI tool for interacting with language models";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.llm;
      description = "The llm package to use";
    };
    
    defaultModel = lib.mkOption {
      type = lib.types.str;
      default = "gemini-2.5-flash-preview-05-20";
      description = "Default LLM model to use";
    };
    
    installGemini = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to install llm-gemini plugin";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # LLM configuration directory
    xdg.configFile."io.datasette.llm/.keep".text = "";

    # Post-install setup script
    home.activation.llmSetup = lib.hm.dag.entryAfter ["writeBoundary"] ''
      if [ ! -f "$HOME/.config/io.datasette.llm/logs.db" ]; then
        $DRY_RUN_CMD ${cfg.package}/bin/llm install llm-gemini || true
        $DRY_RUN_CMD ${cfg.package}/bin/llm models default ${cfg.defaultModel} || true
      fi
    '';
  };
}
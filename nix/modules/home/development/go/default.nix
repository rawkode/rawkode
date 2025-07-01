{ config, lib, pkgs, ... }:

let
  cfg = config.programs.go;
in
{
  options.programs.go = {
    enable = lib.mkEnableOption "Go programming language";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.go;
      description = "The Go package to use";
    };
    
    goPath = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/Code";
      description = "The GOPATH directory";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; [
      cfg.package
      # Common Go development tools
      gopls
      golangci-lint
      go-tools
      gomodifytags
      gotests
      gocode-gomod
      delve
      impl
    ];

    home.sessionVariables = {
      GOPATH = cfg.goPath;
      GO111MODULE = "on";
    };

    home.sessionPath = [
      "${cfg.goPath}/bin"
    ];

    # Fish configuration
    programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
      set -gx GOPATH ${cfg.goPath}
      fish_add_path $GOPATH/bin
    '';

    # Nushell configuration
    programs.nushell.extraConfig = lib.mkIf config.programs.nushell.enable ''
      use std/util "path add"
      path add "${cfg.goPath}/bin"
    '';
  };
}
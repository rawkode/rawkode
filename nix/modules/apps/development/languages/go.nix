_: {
  flake.homeModules.development-go =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [
        go
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
        GOPATH = "${config.home.homeDirectory}/Code";
        GO111MODULE = "on";
      };

      home.sessionPath = [
        "${config.home.homeDirectory}/Code/bin"
      ];

      programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
        set -gx GOPATH ${config.home.homeDirectory}/Code
        fish_add_path $GOPATH/bin
      '';

      programs.nushell.extraConfig = lib.mkIf config.programs.nushell.enable ''
        use std/util "path add"
        path add "${config.home.homeDirectory}/Code/bin"
      '';
    };
}

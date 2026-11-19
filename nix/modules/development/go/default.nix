_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "go";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [
        go
        gopls
        golangci-lint
        go-tools
        gomodifytags
        gotests
        delve
        impl
      ];

      home.sessionVariables = {
        GOPATH = "${config.home.homeDirectory}/Code";
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

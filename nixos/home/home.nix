{ config, pkgs, ... }:

let
  isDir = path: builtins.pathExists (path + "/.");

  include = path:
    if isDir path
    then
      let
        content = builtins.readDir path;
      in
        map (n: import (path + ("/" + n)))
            (builtins.filter (n: builtins.match ".*\\.nix" n != null || builtins.pathExists (path + ("/" + n + "/default.nix")))
                    (builtins.attrNames content))
    else
    import path;
in {
  nixpkgs.config.allowUnfree = true;

  programs.home-manager = {
    enable = true;
    path = https://github.com/rycee/home-manager/archive/master.tar.gz;
  };

  home.packages = (with pkgs; [
    vim
  ]);

  imports = include ./includes;
}

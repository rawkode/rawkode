{ config, pkgs, ... }:

{
  home.packages = (with pkgs; [
    vscode
  ]);
}

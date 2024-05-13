{ config, pkgs, ... }:

{
  home.packages = (with pkgs; [
    slack
    zoom-us
  ]);
}

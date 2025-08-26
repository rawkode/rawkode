{ pkgs, ... }:
{
  home.packages = with pkgs; [
    rquickshare
  ];
}

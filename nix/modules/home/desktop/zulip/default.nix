{ lib, pkgs, ... }:
{
  home.packages = [ pkgs.zulip ];

  home.sessionVariables = {
    NIXOS_OZONE_WL = "1";
  };
}

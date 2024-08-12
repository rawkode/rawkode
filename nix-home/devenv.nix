{ pkgs, ... }:
{
  languages.nix.enable = true;
  languages.lua.enable = true;
  packages = with pkgs; [
    luaformatter
  ];
}

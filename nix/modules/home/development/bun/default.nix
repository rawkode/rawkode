{ pkgs, ... }:
{
  home.packages = with pkgs; [ bun ];

  programs = {
    fish = {
      shellInit = ''
        fish_add_path ~/.bun/bin
      '';
    };
  };
}

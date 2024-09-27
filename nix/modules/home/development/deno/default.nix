{ pkgs, ... }:
{
  home.packages = with pkgs; [
    deno
  ];

  programs = {
    fish = {
      shellInit = ''
        fish_add_path ~/.deno/bin
      '';
    };
  };
}

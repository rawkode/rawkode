{ pkgs, ... }:
{
  home.packages = with pkgs; [
    eza
  ];

  programs = {
    fish = {
      shellAliases = {
        ls = "eza -al --icons -m --no-user --time-style relative --git";
      };
    };
  };
}

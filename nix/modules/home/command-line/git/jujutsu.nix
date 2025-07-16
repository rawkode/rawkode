{ pkgs, ... }:
{
  home.packages = with pkgs; [ jujutsu ];
  xdg.configFile."jj/config.toml".source = ./jj.toml;
}

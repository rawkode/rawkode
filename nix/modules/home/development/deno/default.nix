{ pkgs, ... }:
{
  home.packages = with pkgs; [ deno ];
  home.sessionPath = [ "$HOME/.deno/bin" ];
}

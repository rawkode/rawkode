{ pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      runme
      biome
      devenv
      zed-editor
    ]
  );
}

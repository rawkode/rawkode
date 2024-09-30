{ pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      runme
      biome
      devenv
      # gitbutler
      # helix

      # zed-editor
    ]
  );
}

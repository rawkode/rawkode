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
      nixfmt-rfc-style
      # zed-editor
    ]
  );
}

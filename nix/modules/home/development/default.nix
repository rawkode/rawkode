{ pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      rawkOS.runme

      biome
      devenv
      gitbutler
      helix
      nixfmt-rfc-style
      zed-editor
    ]
  );
}

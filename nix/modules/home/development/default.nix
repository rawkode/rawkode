{ pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      devenv
      gitbutler
      helix
      nixfmt-rfc-style
      zed-editor
    ]
  );
}

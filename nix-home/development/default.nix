{ pkgs, ... }:
{
  imports = [
    ./git.nix
    ./vscode.nix
  ];

  home.packages = (
    with pkgs;
    [
      devenv
      # Currently pending nixpkgs fix
      # gitbutler
      helix
      nixfmt-rfc-style
      zed-editor
    ]
  );
}

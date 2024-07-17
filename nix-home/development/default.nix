{ pkgs, ... }:

{
  imports = [
    ./git.nix
    ./vscode.nix
  ];

  home.packages = (
    with pkgs;
    [
      rustup
      zed-editor
    ]
  );
}

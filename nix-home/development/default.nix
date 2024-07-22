{ pkgs, ... }:

{
  imports = [
    ./git.nix
    ./vscode.nix
  ];

  home.packages = (
    with pkgs;
    [
			glab
      rustup
      zed-editor
    ]
  );
}

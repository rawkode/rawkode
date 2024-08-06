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
			nixfmt-rfc-style
      rustup
      zed-editor
    ]
  );
}
